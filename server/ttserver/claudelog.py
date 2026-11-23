"""What Gabe was actually doing in Claude: his Claude conversations, fused
into the timeline.

The laptop job (deploy/claude-sync.py) reads every conversation the Claude
Code login can see (local Claude Code and desktop sessions, claude.ai/code
cloud sessions, Hearth threads) and posts each message to POST /tt/claude:
when it was written, which session (and its title), who wrote it (you or
claude) and the text. They're kept here, one row per message.

GET /tt/claude/blocks then takes the activity timeline, finds every stretch
spent in Claude (the desktop app, claude.ai in a browser, a terminal running
Claude Code, the phone app), and attaches the messages written during it:
which sessions, what he typed, and a label, a blunt one-sentence summary
and a kind (building, debugging, planning, ..., tinkering, venting) written
by the same free LLM chain as the dashboard's labels and cached.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone

from . import activity, labels
from .lines import parse_ts
from .store import iso_utc

SCHEMA = """
CREATE TABLE IF NOT EXISTS claude (
    id TEXT PRIMARY KEY,         -- hash of session, ts, who and text
    ts TEXT NOT NULL,            -- UTC ISO 8601
    surface TEXT,                -- local (laptop), cloud (claude.ai/code, Hearth)
    session TEXT,
    title TEXT,
    who TEXT NOT NULL,           -- you or claude
    text TEXT NOT NULL,
    received REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS claude_by_time ON claude (ts);
"""

MAX_TEXT = {"you": 4000, "claude": 1500}
CLAUDE_APP = re.compile(r"claude", re.I)
CLAUDE_SITE = re.compile(r"(^|\.)claude\.(ai|com)$", re.I)
MERGE_GAP = 300        # seconds between Claude segments that still make one block
MIN_BLOCK = 60         # seconds of Claude in a block, or it's dropped
SLACK = timedelta(minutes=2)  # messages this close to a block's edges belong to it
KINDS = ["building", "debugging", "planning", "research", "learning", "writing", "admin",
         "tinkering", "venting", "other"]


def ensure(store) -> None:
    with store.lock:
        store.db.executescript(SCHEMA)


def ingest(store, body: str) -> dict:
    """POST /tt/claude: a JSON array (or one object per line) of messages."""
    body = body.strip()
    try:
        records = json.loads(body) if body.startswith("[") else [json.loads(l) for l in body.splitlines() if l.strip()]
    except json.JSONDecodeError as e:
        raise ValueError(f"expected JSON: {e}") from None
    ensure(store)
    new = 0
    now = time.time()
    with store.lock, store.db:
        for r in records:
            if not isinstance(r, dict):
                continue
            ts = parse_ts(r.get("ts"))
            who = "you" if r.get("who") == "you" else "claude"
            text = str(r.get("text") or "").strip()[:MAX_TEXT[who]]
            if ts is None or not text:
                continue
            session = str(r.get("session") or r.get("title") or "")
            key = hashlib.sha256(f"{session}\n{iso_utc(ts)}\n{who}\n{text}".encode()).hexdigest()
            if store.db.execute("SELECT 1 FROM claude WHERE id = ?", (key,)).fetchone():
                # Seen before; a session's title can arrive later than its first messages.
                if r.get("title"):
                    store.db.execute("UPDATE claude SET title = ? WHERE id = ?", (r.get("title"), key))
                continue
            store.db.execute(
                "INSERT INTO claude (id, ts, surface, session, title, who, text, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (key, iso_utc(ts), r.get("surface"), session, r.get("title"), who, text, now))
            new += 1
    return {"ok": True, "received": len(records), "new": new}


def events(store, start: datetime, end: datetime, who: str | None = None) -> list[dict]:
    ensure(store)
    q = "SELECT ts, surface, session, title, who, text FROM claude WHERE ts >= ? AND ts < ?"
    args = [iso_utc(start), iso_utc(end)]
    if who:
        q += " AND who = ?"
        args.append(who)
    with store.lock:
        rows = store.db.execute(q + " ORDER BY ts", args).fetchall()
    return [{"ts": ts, "surface": s, "session": sess, "title": t, "who": w, "text": x} for ts, s, sess, t, w, x in rows]


def is_claude(seg: dict) -> bool:
    return bool(CLAUDE_APP.search(seg.get("app") or "") or CLAUDE_SITE.search(seg.get("domain") or "")
                or re.search(r"\bClaude Code\b", seg.get("title") or ""))


def blocks(aw, store, labeler, q: dict[str, str]) -> dict:
    """GET /tt/claude/blocks: each stretch in Claude with what was written in it."""
    act = activity.activity(aw, {**q, "view": "devices", "format": "json"})[1]
    tz = activity.zone(q.get("tz"))
    segs = sorted((s for s in act["segments"] if is_claude(s)), key=lambda s: s["start"])
    out: list[dict] = []
    for s in segs:
        a, b = datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"])
        if out and (a - out[-1]["_end"]).total_seconds() <= MERGE_GAP:
            blk = out[-1]
            blk["_end"] = max(blk["_end"], b)
        else:
            blk = {"_start": a, "_end": b, "seconds": 0.0, "devices": {}, "apps": {}}
            out.append(blk)
        blk["seconds"] += s["seconds"]
        blk["devices"][s["device"]] = blk["devices"].get(s["device"], 0) + s["seconds"]
        where = s.get("domain") or s.get("app") or "?"
        blk["apps"][where] = blk["apps"].get(where, 0) + s["seconds"]
    out = [b for b in out if b["seconds"] >= MIN_BLOCK]

    result = []
    for b in out:
        msgs = events(store, b["_start"] - SLACK, b["_end"] + SLACK)
        sessions: dict[str, dict] = {}
        for m in msgs:
            ses = sessions.setdefault(m["session"], {"title": m["title"], "surface": m["surface"], "you": 0, "claude": 0})
            ses[m["who"]] += 1
            ses["title"] = m["title"] or ses["title"]
        result.append({
            "start": b["_start"].astimezone(tz).isoformat(timespec="seconds"),
            "end": b["_end"].astimezone(tz).isoformat(timespec="seconds"),
            "seconds": round(b["seconds"]),
            "devices": {k: round(v) for k, v in b["devices"].items()},
            "where": {k: round(v) for k, v in sorted(b["apps"].items(), key=lambda kv: -kv[1])},
            "sessions": sorted(sessions.values(), key=lambda s: -(s["you"] + s["claude"])),
            "typed": [{"ts": datetime.fromisoformat(m["ts"]).astimezone(tz).isoformat(timespec="seconds"),
                       "session": m["title"], "text": m["text"][:600]} for m in msgs if m["who"] == "you"],
            "_msgs": msgs,
        })
    notes = ["labels off"] if labeler is None or q.get("label", "1") == "0" else describe(labeler, result)
    for r in result:
        r.pop("_msgs", None)
    return {"start": act["start"], "end": act["end"], "tz": act["tz"], "count": len(result),
            "claude_seconds": sum(r["seconds"] for r in result), "label_notes": notes, "blocks": result}


SYSTEM = (
    "You review someone's own Claude usage for their personal time tracker. For each block you get how long "
    "they spent in Claude, the session titles, and the messages they typed (plus a little of Claude's replies). "
    "Say plainly what they were actually doing, the way a blunt friend reading over their shoulder would: "
    "if it was productive work, name the project and the task; if it was fiddling with tooling, arguing with "
    "the assistant, redoing setup, or a distraction, say so. Answer with only a JSON object mapping each "
    "block id to {\"label\": at most 8 words, \"summary\": one sentence, \"kind\": one of "
    + ", ".join(KINDS) + "}."
)


def _block_prompt(b: dict) -> dict:
    you = [m for m in b["_msgs"] if m["who"] == "you"]
    claude = [m for m in b["_msgs"] if m["who"] == "claude"]
    return {"minutes": round(b["seconds"] / 60, 1),
            "sessions": [s["title"] for s in b["sessions"] if s["title"]][:6],
            "typed": [m["text"][:300] for m in you[:15]],
            "claude_said": [m["text"][:200] for m in claude[-3:]]}


def describe(labeler, result: list[dict]) -> list[str]:
    """Fills label/summary/kind for blocks with messages, from the cache or the LLM chain.
    Returns notes on providers that failed."""
    notes: list[str] = [] if labeler.chain else ["no LLM provider configured"]
    todo = []
    for b in result:
        if not b["_msgs"]:
            b.update(label=None, summary=None, kind=None)
            continue
        p = _block_prompt(b)
        key = "claude:" + hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest()[:32]
        hit = labeler.cached([key]).get(key)
        if hit:
            b.update(json.loads(hit[0]))
        else:
            todo.append((key, b, p))
    for n in range(0, len(todo), 8):
        batch = todo[n:n + 8]
        ids = [f"b{i + 1}" for i in range(len(batch))]
        user = json.dumps({bid: p for bid, (_, _, p) in zip(ids, batch)}, ensure_ascii=False)
        for prov in labeler.chain:
            if labeler.cooldown.get(prov.name, 0) > time.time():
                notes.append(f"{prov.name}: cooling down")
                continue
            try:
                text, prov = labeler.complete(prov, SYSTEM, user)
                answer = _parse(text, ids)
            except labels.ProviderError as e:
                if e.retry_after:
                    labeler.cooldown[prov.name] = time.time() + e.retry_after
                notes.append(f"{prov.name}: {e}")
                labeler.log("claude labels:", prov.name, "failed:", e)
                continue
            if not answer:
                notes.append(f"{prov.name}: unusable answer: {(text or '')[:120]!r}")
                labeler.log("claude labels:", prov.name, "answered nothing usable:", (text or "")[:200])
                continue
            rows = []
            for bid, (key, b, _) in zip(ids, batch):
                if bid in answer:
                    b.update(answer[bid])
                    rows.append((key, json.dumps(answer[bid]), f"{prov.name}/{prov.model}"))
            labeler.remember(rows)
            break
    for b in result:
        for k in ("label", "summary", "kind"):
            b.setdefault(k, None)
    return notes


def _parse(text: str, ids: list[str]) -> dict[str, dict]:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    out = {}
    for bid in ids:
        v = data.get(bid) if isinstance(data, dict) else None
        if not isinstance(v, dict) or not isinstance(v.get("label"), str):
            continue
        kind = v.get("kind") if v.get("kind") in KINDS else "other"
        out[bid] = {"label": " ".join(v["label"].split()[:10]), "summary": str(v.get("summary") or "")[:300],
                    "kind": kind}
    return out
