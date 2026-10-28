"""Short labels for the dashboard's blocks ("Writing in Overleaf"), written by
a free LLM API and cached in SQLite.

The dashboard groups the day into blocks and posts each block's top items to
/tt/labels. A block is cached by a coarse digest of its content (main
subjects in order and their titles, letters only), so a live block
that keeps growing keeps its label instead of asking the model every refresh.
Uncached blocks go to the model in batches, one call per BATCH blocks.

Providers are tried in order: the keyed ones whose key is set (free tiers,
OpenAI-compatible chat endpoints), then the keyless ones only if
TT_LLM_KEYLESS=1: they take block titles with no account, so who keeps them
is unknown. A provider that fails, times out, rate-limits or answers
garbage is skipped for the blocks it didn't label. A block nobody labels is
left out of the answer, and the dashboard keeps its own heuristic label.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, NamedTuple

MAX_BLOCKS = 60     # per request
MAX_ITEMS = 6       # per block
MAX_TITLE = 80      # characters
BATCH = 20          # blocks per model call
TIMEOUT = 20        # seconds per model call
COOLDOWN = 60       # seconds a rate-limited provider is skipped, unless it says otherwise
MAX_WORDS = 6       # the prompt asks for 5; a 6th is tolerated, longer ones are cut

SCHEMA = """
CREATE TABLE IF NOT EXISTS labels (
    key TEXT PRIMARY KEY,        -- content_key() of the block
    label TEXT NOT NULL,
    model TEXT NOT NULL,         -- provider/model that wrote it
    created REAL NOT NULL
);
"""

SYSTEM = (
    "You name stretches of someone's screen time for their own timeline. For each block you get "
    "its main apps or sites with a window or page title, minutes and category. Answer with one label "
    "per block: at most 5 words, naming the activity and where it happened, e.g. \"Writing in Overleaf\", "
    "\"CAD in SolidWorks\", \"Andor on Disney+\", \"Email and Slack\", \"Python in VS Code\", "
    "\"YouTube videos\". Use the show, project or document name only when a title makes it plain. "
    "Describe only what the titles show; don't guess at feelings or private matters. "
    "Answer with only a JSON object mapping each block id to its label."
)


class Provider(NamedTuple):
    name: str
    url: str        # the chat completions endpoint
    model: str
    key: str | None


# (name, chat completions URL, default model, key variable). Keyed providers first,
# fastest and most generous free tier first. TT_LLM_<NAME>_MODEL overrides the model.
KEYED = [
    ("groq", "https://api.groq.com/openai/v1/chat/completions", "openai/gpt-oss-20b", "TT_LLM_GROQ_KEY"),
    ("cerebras", "https://api.cerebras.ai/v1/chat/completions", "gpt-oss-120b", "TT_LLM_CEREBRAS_KEY"),
    ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
     "gemini-2.5-flash-lite", "TT_LLM_GEMINI_KEY"),
    ("mistral", "https://api.mistral.ai/v1/chat/completions", "ministral-8b-latest", "TT_LLM_MISTRAL_KEY"),
    ("openrouter", "https://openrouter.ai/api/v1/chat/completions", "openrouter/free", "TT_LLM_OPENROUTER_KEY"),
]
# No sign-up. LLM7 takes an optional free token for higher limits.
KEYLESS = [
    ("llm7", "https://api.llm7.io/v1/chat/completions", "gpt-oss:20b", "TT_LLM_LLM7_KEY"),
    ("kilo", "https://api.kilo.ai/api/gateway/chat/completions", "kilo-auto/free", None),
    ("ovh", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", "gpt-oss-20b", None),
]


def providers(env=os.environ) -> list[Provider]:
    """The configured chain, in the order to try it."""
    def model(name: str, default: str) -> str:
        return env.get(f"TT_LLM_{name.upper()}_MODEL") or default

    out = [Provider(n, url, model(n, m), env[k]) for n, url, m, k in KEYED if env.get(k)]
    if env.get("TT_LLM_KEYLESS", "0") == "1":
        out += [Provider(n, url, model(n, m), env.get(k) if k else None) for n, url, m, k in KEYLESS]
    return out


# ---------------------------------------------------------------- block content

def clean_items(items) -> list[dict]:
    """The block's items as the model sees them: at most MAX_ITEMS, longest first, titles cut."""
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        try:
            seconds = max(0.0, float(it.get("seconds") or 0))
        except (TypeError, ValueError):
            seconds = 0.0
        out.append({k: str(it.get(k) or "")[:MAX_TITLE] for k in ("subject", "app", "title", "category")}
                   | {"seconds": seconds})
    out = sorted((it for it in out if it["subject"] or it["app"]), key=lambda it: -it["seconds"])
    return out[:MAX_ITEMS]


def _title_norm(title: str) -> str:
    # Letters only: digits and punctuation change on their own (unread counts, timers).
    return re.sub(r"[\W\d_]+", " ", title.lower()).strip()[:40].strip()


def content_norm(items: list[dict]) -> str:
    """What a block's label depends on, coarsely: its main subjects in order (the top one,
    then any with at least 15% of the block, at most 3) and their titles, letters only.
    Durations count only through that order and cut-off, so a growing block keeps its key.
    The dashboard computes the same string (labels.ts, contentNorm)."""
    total = sum(it["seconds"] for it in items) or 1.0
    main = [it for i, it in enumerate(items[:3]) if i == 0 or it["seconds"] / total >= 0.15]
    return "\n".join(f"{(it['subject'] or it['app']).lower()}|{_title_norm(it['title'])}" for it in main)


def content_key(items: list[dict]) -> str:
    return hashlib.sha256(content_norm(items).encode()).hexdigest()[:32]


# ---------------------------------------------------------------- model output

def clean_label(label) -> str | None:
    """One label as shown: no quotes or final period, a few words at most."""
    if not isinstance(label, str):
        return None
    label = re.sub(r"\s+", " ", label).strip().strip("\"'`*.").strip()
    words = label.split(" ")
    if len(words) > MAX_WORDS:
        label = " ".join(words[:5])
    return label[:60] or None


def parse_labels(text: str, ids: list[str]) -> dict[str, str]:
    """The labels in a model's answer, for the ids asked about. Tolerates reasoning
    blocks, code fences and prose around the JSON, and broken JSON."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    found: dict = {}
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(text[start:end + 1])
            if isinstance(obj, dict):
                found = obj
        except json.JSONDecodeError:
            pass
    if not found:
        found = dict(re.findall(r'"?(b\d+)"?\s*[:=]\s*"([^"\n]+)"', text))
    out = {}
    for i in ids:
        if (label := clean_label(found.get(i))) is not None:
            out[i] = label
    return out


# ---------------------------------------------------------------- calling providers

class ProviderError(Exception):
    def __init__(self, msg: str, retry_after: float | None = None):
        super().__init__(msg)
        self.retry_after = retry_after


def chat(p: Provider, system: str, user: str) -> str:
    """One chat completion; the answer's text."""
    body = {"model": p.model, "temperature": 0.2, "max_tokens": 2000,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    headers = {"Content-Type": "application/json", "User-Agent": "tt-relay"}
    if p.key:
        headers["Authorization"] = f"Bearer {p.key}"
    req = urllib.request.Request(p.url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            data = json.loads(res.read())
    except urllib.error.HTTPError as e:
        retry = None
        if e.code == 429:
            try:
                retry = float(e.headers.get("Retry-After") or COOLDOWN)
            except (TypeError, ValueError):
                retry = COOLDOWN
        raise ProviderError(f"HTTP {e.code}", retry) from e
    except (OSError, ValueError) as e:  # timeouts, refused connections, bad JSON
        raise ProviderError(f"{type(e).__name__}: {e}") from e
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise ProviderError("no choices in the answer") from e


def prompt(batch: list[list[dict]]) -> tuple[list[str], str]:
    """Short ids (b1, b2, ...) for a batch and the user message describing it."""
    ids = [f"b{i + 1}" for i in range(len(batch))]
    blocks = {}
    for bid, items in zip(ids, batch):
        blocks[bid] = [{"subject": it["subject"] or it["app"],
                        **({"app": it["app"]} if it["app"] and it["app"] != it["subject"] else {}),
                        "title": it["title"], "minutes": round(it["seconds"] / 60, 1),
                        **({"category": it["category"]} if it["category"] else {})} for it in items]
    return ids, json.dumps(blocks, ensure_ascii=False)


class Labeler:
    """The label cache and the provider chain behind /tt/labels."""

    def __init__(self, path: str, chain: list[Provider] | None = None,
                 call: Callable[[Provider, str, str], str] = chat, log: Callable[..., None] | None = None):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()
        self.chain = providers() if chain is None else chain
        self.call = call
        self.log = log or (lambda *a: None)
        self.cooldown: dict[str, float] = {}

    def cached(self, keys: list[str]) -> dict[str, tuple[str, str]]:
        if not keys:
            return {}
        with self.lock:
            rows = self.db.execute(f"SELECT key, label, model FROM labels WHERE key IN ({','.join('?' * len(keys))})",
                                   keys).fetchall()
        return {k: (label, model) for k, label, model in rows}

    def remember(self, rows: list[tuple[str, str, str]]) -> None:
        now = time.time()
        with self.lock, self.db:
            self.db.executemany("INSERT OR REPLACE INTO labels (key, label, model, created) VALUES (?, ?, ?, ?)",
                                [(k, label, model, now) for k, label, model in rows])

    def ask(self, batch: list[list[dict]]) -> list[tuple[str, str] | None]:
        """(label, provider/model) for each block of a batch, None where nobody answered."""
        got: dict[int, tuple[str, str]] = {}
        for p in self.chain:
            todo = [n for n in range(len(batch)) if n not in got]
            if not todo:
                break
            if self.cooldown.get(p.name, 0) > time.time():
                continue
            ids, user = prompt([batch[n] for n in todo])  # only what earlier providers missed
            try:
                answer = parse_labels(self.call(p, SYSTEM, user), ids)
            except ProviderError as e:
                if e.retry_after:
                    self.cooldown[p.name] = time.time() + e.retry_after
                self.log("labels:", p.name, "failed:", e)
                continue
            if not answer:
                self.log("labels:", p.name, "answered nothing usable")
            for bid, n in zip(ids, todo):
                if bid in answer:
                    got[n] = (answer[bid], f"{p.name}/{p.model}")
        return [got.get(n) for n in range(len(batch))]

    def label(self, blocks) -> dict:
        """The /tt/labels answer for the request body's blocks."""
        wanted: dict[str, list[str]] = {}       # content key -> block ids
        content: dict[str, list[dict]] = {}
        for b in (blocks if isinstance(blocks, list) else [])[:MAX_BLOCKS]:
            if not isinstance(b, dict) or not isinstance(b.get("id"), str):
                continue
            items = clean_items(b.get("items"))
            if not items:
                continue
            k = content_key(items)
            wanted.setdefault(k, []).append(b["id"])
            content.setdefault(k, items)
        hit = self.cached(list(wanted))
        found = {k: label for k, (label, _) in hit.items()}
        model = next(iter(hit.values()))[1] if hit else None
        missing = [k for k in wanted if k not in found]
        for n in range(0, len(missing), BATCH):
            keys = missing[n:n + BATCH]
            fresh = [(k, *got) for k, got in zip(keys, self.ask([content[k] for k in keys])) if got]
            self.remember(fresh)
            found.update((k, label) for k, label, _ in fresh)
            model = fresh[0][2] if fresh else model
        return {"labels": {bid: found[k] for k, ids in wanted.items() if k in found for bid in ids},
                "model": model}
