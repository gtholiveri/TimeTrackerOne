"""An MCP server on the relay, so an assistant (Claude, Hermes) can pull every
stream with tools instead of reading docs/agent-api.md and building URLs.

Streamable HTTP, stateless, JSON responses only (no SSE): POST /mcp with the
key as a bearer token or ?key=, or POST /mcp/<KEY> for clients that can only
take a URL (Claude.ai custom connectors). Read keys work; nothing here writes.

Tools cover all of it: the fused live state, the categorized activity and
daily totals (laptop + phone + Safari, via ActivityWatch), the raw phone
lines, the location track and visits, motion, WHOOP, and what arrived when.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from . import claudelog, coverage, daystory

PROTOCOL = "2025-06-18"

_RANGE = {
    "days": {"type": "number", "description": "How many days back from now (default 1, or 7 for summaries)."},
    "start": {"type": "string", "description": "Start date or time, e.g. 2026-11-20 or 2026-11-20T08:00 (local to tz)."},
    "end": {"type": "string", "description": "End date or time, exclusive."},
    "tz": {"type": "string", "description": "IANA time zone for days and output, default America/Los_Angeles."},
}
_HOURS = {"hours": {"type": "number", "description": "How many hours back from now (default 24)."}}


def _tool(name, description, props=None, required=None):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, **({"required": required} if required else {})},
            "annotations": {"readOnlyHint": True}}


TOOLS = [
    _tool("get_live_state", "What Gabe is doing right now on each device (app, locked, page), with the "
          "fused phone timeline for the last few hours.", {"hours": {"type": "number", "description": "Default 6."}}),
    _tool("get_coverage", "What the relay received per day (phone line counts by kind, Safari, devices) and "
          "every TT Watch run with its first and last line. Use it to check the trackers are alive.",
          {"days": {"type": "number", "description": "How many days back (default 7)."},
           "tz": _RANGE["tz"]}),
    _tool("get_daily_summary", "Per-day totals across laptop, phone and Safari: time by category, rating, app "
          "and site, plus unlock counts. The cheapest way to look at days and weeks.",
          {**_RANGE, "top": {"type": "integer", "description": "How many top apps/sites per day (default 10)."}}),
    _tool("get_activity", "Categorized activity segments in time order (what was on screen, when, for how "
          "long, on which device). view=attention merges devices into one line; view=devices keeps them apart.",
          {**_RANGE, "view": {"type": "string", "enum": ["attention", "devices"]},
           "min_seconds": {"type": "number", "description": "Drop segments shorter than this."}}),
    _tool("get_claude_blocks", "Every stretch Gabe spent in Claude (desktop, claude.ai, Claude Code, phone) with "
          "the sessions, what he typed, and a structured label of each sitting: project, goal, kind, verdict "
          "(productive, mixed, unproductive, unclear) and a one-line summary.",
          {**_RANGE}),
    _tool("get_day_story", "The story of a day: what happened, written from all of the day's data at midday "
          "and once the day is verifiably over (asleep: WHOOP's sleep, or every device quiet 4 h through 2-8 AM) (headline, how it went, numbers, worth noticing). Newest first.",
          {"day": {"type": "string", "description": "YYYY-MM-DD, default today."}}),
    _tool("get_claude_messages", "Gabe's Claude messages (and Claude's replies) in time order, from every "
          "surface the laptop's Claude login sees.",
          {**_HOURS, "who": {"type": "string", "enum": ["you", "claude"], "description": "Only one side."}}),
    _tool("get_location", "The phone's location: GPS track points (lat, lon, accuracy m, altitude, speed m/s, "
          "course) and visits (arrive, depart, lat, lon), oldest first. Raw coordinates, not snapped.", _HOURS),
    _tool("get_motion", "The phone's motion activity changes (stationary, walking, running, cycling, "
          "automotive) with confidence, oldest first. ts is when the activity started.", _HOURS),
    _tool("get_whoop", "WHOOP records as WHOOP's API returns them: cycle (strain, kJ, HR), recovery "
          "(score, HRV, resting HR, SpO2, skin temp), sleep (stages, performance, need), workout, profile, body.",
          {"kind": {"type": "string", "enum": ["cycle", "recovery", "sleep", "workout", "profile", "body"],
                    "description": "Leave out for all kinds."},
           "days": {"type": "number", "description": "How many days back (default 7)."}}),
    _tool("get_raw_lines", "Every raw line the relay received, oldest first, for debugging or anything the "
          "other tools don't cover. Phone kinds: start/change/beat/end (TT Watch), open/close (automations), "
          "loc/visit/locpause (location), motion.",
          {**_HOURS, "source": {"type": "string", "enum": ["ios", "safari"], "description": "Default ios."},
           "kinds": {"type": "array", "items": {"type": "string"}, "description": "Only these kinds."},
           "limit": {"type": "integer", "description": "At most this many, newest kept (default 2000)."}}),
]


def _q(args: dict) -> dict[str, str]:
    """Tool arguments as the query dict the HTTP endpoints take."""
    return {k: str(v) for k, v in args.items() if v is not None and v != ""}


def _since(args: dict, default_hours: float = 24) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=float(args.get("hours") or default_hours))


def _phone_lines(relay, args, kinds: set[str], default_hours=24) -> list[dict]:
    out = []
    for dev, d in relay.store.lines("ios", _since(args, default_hours)):
        if d.get("kind") in kinds:
            row = {k: v for k, v in d.items() if k not in ("src",)}
            row["dev"] = row.get("dev") or dev
            out.append(row)
    return out


def call(relay, whoop, name: str, args: dict, state_json, activity_mod, labeler=None):
    if name == "get_live_state":
        return state_json(relay, float(args.get("hours") or 6))
    if name == "get_claude_blocks":
        if relay.aw is None:
            raise ValueError("ActivityWatch isn't connected on the relay")
        return claudelog.blocks(relay.aw, relay.store, labeler, _q(args))
    if name == "get_day_story":
        day = args.get("day") or daystory.today(datetime.now(timezone.utc))
        return {"day": day, "stories": daystory.stories(relay.store, day)}
    if name == "get_claude_messages":
        now = datetime.now(timezone.utc)
        return claudelog.events(relay.store, _since(args), now, args.get("who"))
    if name == "get_coverage":
        return coverage.coverage(relay.store, min(float(args.get("days") or 7), 90),
                                 args.get("tz") or "America/Los_Angeles")
    if name in ("get_daily_summary", "get_activity"):
        if relay.aw is None:
            raise ValueError("ActivityWatch isn't connected on the relay")
        if name == "get_daily_summary":
            return activity_mod.summary(relay.aw, _q(args))
        _, body = activity_mod.activity(relay.aw, {**_q(args), "format": "json"})
        return body
    if name == "get_location":
        return _phone_lines(relay, args, {"loc", "visit", "locpause"})
    if name == "get_motion":
        return _phone_lines(relay, args, {"motion"})
    if name == "get_whoop":
        if whoop is None:
            raise ValueError("WHOOP isn't set up on the relay yet (TT_WHOOP_CLIENT_ID/SECRET, then /tt/whoop/connect)")
        since = datetime.now(timezone.utc) - timedelta(days=float(args.get("days") or 7))
        return {"status": whoop.status(), "records": whoop.records(args.get("kind") or None, since)}
    if name == "get_raw_lines":
        source = args.get("source") or "ios"
        kinds = set(args.get("kinds") or [])
        rows = relay.store.raw(source, _since(args))
        if kinds:
            rows = [r for r in rows if any(f"|kind={k}|" in r or f'"kind": "{k}"' in r for k in kinds)]
        return rows[-int(args.get("limit") or 2000):]
    raise KeyError(name)


def handle(message: dict, relay, whoop, state_json, activity_mod, labeler=None) -> dict | None:
    """One JSON-RPC message in, its response out (None for notifications)."""
    mid, method = message.get("id"), message.get("method")
    if mid is None:
        return None  # notifications/initialized and friends
    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}
    def err(code, msg):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": msg}}
    if method == "initialize":
        return ok({"protocolVersion": (message.get("params") or {}).get("protocolVersion") or PROTOCOL,
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "timetracker", "version": "1.0"},
                   "instructions": "Gabe's activity tracker: screens (laptop, phone, Safari), phone location and "
                                   "motion, and WHOOP. Start with get_daily_summary or get_live_state. Times are "
                                   "UTC unless a tz is given."})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": TOOLS})
    if method == "tools/call":
        p = message.get("params") or {}
        try:
            data = call(relay, whoop, p.get("name", ""), p.get("arguments") or {}, state_json, activity_mod, labeler)
        except KeyError:
            return err(-32602, f"unknown tool {p.get('name')!r}")
        except Exception as e:  # a tool error the model can read and recover from
            return ok({"content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}], "isError": True})
        text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, default=str)
        return ok({"content": [{"type": "text", "text": text}]})
    return err(-32601, f"method not found: {method}")
