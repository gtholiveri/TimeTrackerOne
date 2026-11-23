"""Sends Gabe's Claude conversations to the relay (POST /tt/claude), so the
timeline can say what each stretch in Claude was actually about
(claudelog.py). Runs on the laptop, where the Claude Code login lives
(deploy/claude-sync.ps1 makes it a scheduled task).

Sources, the same as the session-history skill:
  local  Claude Code and desktop sessions on this computer: ~/.claude/projects/*/*.jsonl
  cloud  claude.ai/code sessions and Hearth threads, through the sessions API with
         the Claude Code login (~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN)
claude.ai chat-tab conversations aren't reachable with that login.

    python -m ttserver.claudesync [--relay URL] [--key KEY] [--state FILE] [--days 30] [--log FILE]

Relay and key default to TT_RELAY_URL and TT_KEY. Each run sends what's new
since the last one (plus a 3-hour overlap; the relay drops repeats); the
first run goes back --days. Only the standard library.
"""

from __future__ import annotations

import argparse
import glob
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.anthropic.com"
HUMAN = re.compile(r'<message [^>]*from="human"[^>]*sent-at="([^"]+)"[^>]*>(.*?)</message>', re.S)
OVERLAP = timedelta(hours=3)


def parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def text_of(c) -> str:
    if isinstance(c, str):
        return c
    return " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")


def rec(ts, surface, session, title, who, text) -> dict:
    return {"ts": ts.isoformat() if isinstance(ts, datetime) else ts, "surface": surface, "session": session,
            "title": title, "who": who, "text": text}


# ------------------------------------------------------------ local transcripts

def local(since: datetime):
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        if os.path.getmtime(f) < since.timestamp():
            continue
        session = "local:" + os.path.splitext(os.path.basename(f))[0]
        rows, title = [], None
        for line in open(f, encoding="utf-8", errors="ignore"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") in ("ai-title", "custom-title", "summary"):
                title = d.get("customTitle") or d.get("aiTitle") or d.get("summary") or title
            if d.get("type") not in ("user", "assistant") or not d.get("timestamp") or d.get("isSidechain"):
                continue
            ts = parse(d["timestamp"])
            if ts < since:
                continue
            c = d.get("message", {}).get("content")
            if d["type"] == "user":
                if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                    rows.append((ts, "you", c))
            else:
                t = text_of(c)
                if t.strip():
                    rows.append((ts, "claude", t))
        title = title or os.path.basename(os.path.dirname(f)).replace("C--Users-gabeo-", "")
        for ts, who, text in rows:
            yield rec(ts, "local", session, title, who, text)


# ------------------------------------------------------------ cloud sessions

def token() -> str | None:
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return os.environ["CLAUDE_CODE_OAUTH_TOKEN"]
    p = os.path.expanduser("~/.claude/.credentials.json")
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))["claudeAiOauth"]["accessToken"]
    return None


def org() -> str | None:
    if os.environ.get("TT_CLAUDE_ORG"):
        return os.environ["TT_CLAUDE_ORG"]
    p = os.path.expanduser("~/.claude.json")
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8")).get("oauthAccount", {}).get("organizationUuid")
        except ValueError:
            return None
    return None


def cloud(since: datetime, seen: dict, log):
    """Messages from cloud sessions updated since `since`. `seen` maps session id to the
    updated_at already sent, so an unchanged session isn't fetched again."""
    tok, org_id = token(), org()
    if not tok or not org_id:
        log("cloud: no Claude login or organization on this computer; local sessions only")
        return
    headers = {"Authorization": "Bearer " + tok, "anthropic-version": "2023-06-01",
               "anthropic-beta": "ccr-byoc-2025-07-29", "x-organization-uuid": org_id}

    def get(path):
        req = urllib.request.Request(API + path, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res)

    def pages(path):
        after = None
        while True:
            j = get(path + (f"&after_id={after}" if after else ""))
            yield from j.get("data", [])
            if not j.get("has_more") or not j.get("last_id") or j["last_id"] == after:
                return
            after = j["last_id"]

    sessions = {}
    try:
        for src in ["/v1/code/sessions?limit=100&statuses=active&statuses=paused&statuses=archived",
                    "/v1/sessions?limit=100&tags=hearth-thread", "/v1/sessions?limit=100&tags=hearth-overview"]:
            for s in pages(src):
                sid = s["id"].replace("cse_", "session_")
                updated = s.get("updated_at") or s["created_at"]
                # "bridge" sessions mirror this laptop's own sessions, read from disk above.
                if s.get("environment_kind") != "bridge" and parse(updated) >= since and seen.get(sid) != updated:
                    sessions.setdefault(sid, s)
    except urllib.error.HTTPError as e:
        log(f"cloud: listing sessions failed, HTTP {e.code}" + (" (run `claude` once to refresh the login)" if e.code == 401 else ""))
        return
    for sid, s in sessions.items():
        title = s.get("title") or ""
        try:
            for e in pages(f"/v1/sessions/{sid}/events?limit=1000"):
                if e.get("type") not in ("user", "assistant") or parse(e["created_at"]) < since:
                    continue
                c = e.get("message", {}).get("content")
                if e["type"] == "user":
                    raw = (c if isinstance(c, str) else json.dumps(c)).replace('\\"', '"')
                    for at, txt in HUMAN.findall(raw):  # Hearth wakes carry the typed message
                        yield rec(parse(at), "cloud", sid, title, "you", html.unescape(txt))
                    if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                        yield rec(parse(e["created_at"]), "cloud", sid, title, "you", c)
                else:
                    t = text_of(c)
                    if t.strip():
                        yield rec(parse(e["created_at"]), "cloud", sid, title, "claude", t)
            seen[sid] = s.get("updated_at") or s["created_at"]
        except urllib.error.HTTPError as e:
            log(f"cloud: {title or sid}: HTTP {e.code}")


# ------------------------------------------------------------ upload

def post(relay: str, key: str, records: list[dict]) -> int:
    new = 0
    for n in range(0, len(records), 300):
        body = json.dumps(records[n:n + 300], ensure_ascii=False).encode()
        req = urllib.request.Request(relay.rstrip("/") + "/tt/claude", data=body, method="POST",
                                     headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as res:
            new += json.load(res).get("new", 0)
    return new


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--relay", default=os.environ.get("TT_RELAY_URL"))
    ap.add_argument("--key", default=os.environ.get("TT_KEY"))
    ap.add_argument("--state", default=os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                                                    "tt-mirror", "claude-sync.json"))
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--log")
    a = ap.parse_args(argv)
    if not a.relay or not a.key:
        sys.exit("Set TT_RELAY_URL and TT_KEY (or pass --relay and --key).")

    def log(*parts):
        line = f"{datetime.now():%Y-%m-%d %H:%M:%S} " + " ".join(str(p) for p in parts)
        if a.log:
            with open(a.log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        else:
            print(line)

    os.makedirs(os.path.dirname(a.state), exist_ok=True)
    state = {}
    if os.path.exists(a.state):
        try:
            state = json.load(open(a.state, encoding="utf-8"))
        except ValueError:
            state = {}
    started = datetime.now(timezone.utc)
    since = parse(state["last"]) - OVERLAP if state.get("last") else started - timedelta(days=a.days)
    seen = state.get("cloud_seen", {})
    records = list(local(since)) + list(cloud(since, seen, log))
    try:
        new = post(a.relay, a.key, records) if records else 0
    except (urllib.error.URLError, OSError) as e:
        log("upload failed:", e)
        return 1
    json.dump({"last": started.isoformat(), "cloud_seen": seen}, open(a.state, "w", encoding="utf-8"))
    log(f"sent {len(records)} messages since {since:%Y-%m-%d %H:%M} UTC, {new} new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
