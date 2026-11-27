"""The story of the day: the relay reads everything it has for the tracking
day and has the LLM chain write what happened, as a short structured piece
Gabe can read on the dashboard, in the app, or through MCP. Twice a day:
midday (6 hours after the day's first activity) and at the end of the day,
once it is verifiably over (every device quiet for 2 hours, past 6 PM).

Inputs, compacted so one call stays small: the day's totals (activity.summary),
the attention line collapsed into stretches (category, app, the longest title
in each), the Claude blocks with their labels, places (visits, as place A, B,
... with times; no coordinates go to the model), movement (motion changes),
the phone's locks, and WHOOP (sleep, recovery, strain, workouts).

GET /tt/story?day=YYYY-MM-DD gives the day's stories, newest first;
&refresh=1 (full key only) writes one now (slot manual).
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from . import activity, claudelog, labels
from .lines import parse_ts

SCHEMA = """
CREATE TABLE IF NOT EXISTS stories (
    day TEXT NOT NULL,           -- tracking day, YYYY-MM-DD
    slot TEXT NOT NULL,          -- midday, evening or manual
    created REAL NOT NULL,
    model TEXT,
    text TEXT NOT NULL,
    inputs TEXT,                 -- hash of what the model was given
    covers_start TEXT,           -- UTC ISO: the stretch of time the story covers
    covers_end TEXT
);
CREATE INDEX IF NOT EXISTS stories_by_day ON stories (day, created);
"""

# When stories are written. Midday: 6 hours after the day's first activity. End: once the day is
# verifiably over, meaning every device (laptop input, phone unlocked) has been quiet for 2 hours at
# a stretch that reaches past 6 PM. The story then covers up to the last activity, past 4 AM if the
# night ran late, and the next day's story starts from there.
MIDDAY_AFTER = timedelta(hours=6)
QUIET = timedelta(hours=2)
EVENING_HOUR = 18
LOOK = timedelta(hours=40)       # how far past a day's start its end is looked for
TZ = "America/Los_Angeles"
STORY_MODEL = os.environ.get("TT_STORY_MODEL", "claude-sonnet-5-5")  # the Anthropic model; others keep theirs
MAX_STRETCHES = 120

SYSTEM = (
    "You write the daily story for someone's personal time tracker, from everything it recorded today: "
    "screen time on laptop and phone (apps, sites, window titles), what they did in Claude (labeled "
    "sittings), places and movement, phone locks, and WHOOP sleep and strain. Write it for them, in the "
    "second person, like a sharp friend who watched the whole day and doesn't flatter. Use only what's in "
    "the data; where something is missing or unclear, say so instead of guessing.\n\n"
    "Format, in Markdown, under 350 words, nothing before or after:\n"
    "**<one-line headline for the day>**\n\n"
    "### How it went\n"
    "The day in order, in 2 to 4 short paragraphs by part of the day (morning, afternoon, evening, night). "
    "Name the real projects and the real distractions with times.\n\n"
    "### Numbers\n"
    "3 to 5 bullets: the totals that matter (focused time, top time sinks, Claude time, sleep or recovery).\n\n"
    "### Worth noticing\n"
    "1 to 3 bullets: patterns, slips, or wins. If day_over is false, end with what the rest of the day "
    "looks set up for."
)


def ensure(store) -> None:
    with store.lock:
        store.db.executescript(SCHEMA)


def stories(store, day: str) -> list[dict]:
    ensure(store)
    with store.lock:
        rows = store.db.execute("SELECT slot, created, model, text, covers_start, covers_end FROM stories "
                                "WHERE day = ? ORDER BY created DESC", (day,)).fetchall()
    return [{"slot": s, "created": datetime.fromtimestamp(c, timezone.utc).isoformat(timespec="seconds"),
             "model": m, "text": t, "covers_start": a, "covers_end": b} for s, c, m, t, a, b in rows]


def _before(ts: str, end: datetime) -> bool:
    t = parse_ts(ts)
    return t is not None and t < end


def _hm(iso: str, tz) -> str:
    return datetime.fromisoformat(iso).astimezone(tz).strftime("%H:%M")


def _stretches(segs: list[dict], tz) -> list[dict]:
    """The attention line collapsed: consecutive segments of one category (gaps under 5 min) become one
    stretch, with its main app and the title that had the most time."""
    out: list[dict] = []
    for s in segs:
        a, b = datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"])
        cat = s.get("category") or "Uncategorized"
        cur = out[-1] if out else None
        if cur and cur["category"] == cat and (a - cur["_end"]).total_seconds() < 300:
            cur["_end"] = max(cur["_end"], b)
        else:
            cur = {"category": cat, "_start": a, "_end": b, "seconds": 0.0, "_apps": {}, "_titles": {},
                   "rating": s.get("rating")}
            out.append(cur)
        cur["seconds"] += s["seconds"]
        where = s.get("domain") or s.get("app") or "?"
        cur["_apps"][where] = cur["_apps"].get(where, 0) + s["seconds"]
        t = (s.get("title") or "").strip()
        if t:
            cur["_titles"][t] = cur["_titles"].get(t, 0) + s["seconds"]
    out = [s for s in out if s["seconds"] >= 120]
    if len(out) > MAX_STRETCHES:  # keep the longest, in time order
        keep = sorted(sorted(out, key=lambda s: -s["seconds"])[:MAX_STRETCHES], key=lambda s: s["_start"])
        out = keep
    rows = []
    for s in out:
        apps = sorted(s["_apps"].items(), key=lambda kv: -kv[1])
        title = max(s["_titles"].items(), key=lambda kv: kv[1])[0][:90] if s["_titles"] else None
        rows.append({"from": s["_start"].astimezone(tz).strftime("%H:%M"), "to": s["_end"].astimezone(tz).strftime("%H:%M"),
                     "min": round(s["seconds"] / 60), "category": s["category"], "rating": s["rating"],
                     "where": [k for k, _ in apps[:3]], "title": title})
    return rows


def _places(lines: list[dict], tz) -> list[dict]:
    """Visits as place A, B, ... (same place = within ~150 m), with times. No coordinates."""
    places: list[tuple[float, float]] = []
    out = []
    for d in lines:
        if d.get("kind") != "visit":
            continue
        try:
            lat, lon = float(d["lat"]), float(d["lon"])
        except (KeyError, ValueError):
            continue
        idx = next((i for i, (a, b) in enumerate(places) if abs(a - lat) < 0.0014 and abs(b - lon) < 0.0018), None)
        if idx is None:
            places.append((lat, lon))
            idx = len(places) - 1
        name = chr(ord("A") + idx) if idx < 26 else f"#{idx + 1}"
        arrive, depart = parse_ts(d.get("arrive")), parse_ts(d.get("depart"))
        out.append({"place": name, "arrive": arrive.astimezone(tz).strftime("%H:%M") if arrive else "?",
                    "depart": depart.astimezone(tz).strftime("%H:%M") if depart else "still there"})
    return out


def _motion(lines: list[dict], tz, end: datetime) -> dict:
    """Minutes per activity, and the walks/drives/rides over 5 minutes."""
    ms = [(parse_ts(d["ts"]), d.get("activity")) for d in lines if d.get("kind") == "motion" and parse_ts(d.get("ts"))]
    ms.sort()
    totals: dict[str, float] = {}
    trips = []
    for (t, act), nxt in zip(ms, ms[1:] + [(end, None)]):
        mins = max(0.0, (nxt[0] - t).total_seconds() / 60)
        totals[act] = totals.get(act, 0) + mins
        if act in ("walking", "running", "cycling", "automotive") and mins >= 5:
            trips.append({"activity": act, "from": t.astimezone(tz).strftime("%H:%M"), "min": round(mins)})
    return {"minutes": {k: round(v) for k, v in totals.items() if k}, "trips": trips[:40]}


def _locks(lines: list[dict], tz) -> dict:
    """Phone locks from TT Watch: how many, and the longest unlocked stretches."""
    changes = sorted((parse_ts(d["ts"]), d.get("locked")) for d in lines
                     if d.get("kind") in ("change", "beat") and d.get("locked") in ("Yes", "No") and parse_ts(d.get("ts")))
    unlocks, longest, since = 0, [], None
    prev = None
    for t, locked in changes:
        if locked == "No" and prev != "No":
            unlocks += 1
            since = t
        if locked == "Yes" and prev == "No" and since:
            longest.append((t - since, since))
        prev = locked
    longest.sort(reverse=True)
    return {"unlocks_seen": unlocks, "longest_unlocked": [
        {"from": s.astimezone(tz).strftime("%H:%M"), "min": round(d.total_seconds() / 60)} for d, s in longest[:5]]}


def _whoop(whoop, start: datetime, end: datetime, tz) -> list[dict]:
    if whoop is None:
        return []
    out = []
    for r in whoop.records(None, start - timedelta(hours=14)):
        if r.get("kind") not in ("sleep", "recovery", "cycle", "workout"):
            continue
        st = r.get("start") or r.get("created_at")
        try:
            t = datetime.fromisoformat(str(st).replace("Z", "+00:00"))
        except ValueError:
            continue
        if t >= end:
            continue
        row = {"kind": r["kind"], "start": t.astimezone(tz).strftime("%m-%d %H:%M")}
        if r.get("end"):
            try:
                row["end"] = datetime.fromisoformat(str(r["end"]).replace("Z", "+00:00")).astimezone(tz).strftime("%m-%d %H:%M")
            except ValueError:
                pass
        if r.get("sport_name"):
            row["sport"] = r["sport_name"]
        if r.get("nap"):
            row["nap"] = True
        for k, v in (r.get("score") or {}).items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                row[k] = round(v, 1)
        out.append(row)
    return out[-12:]


def _day_start(day: str, tz) -> datetime:
    y, m, d = (int(x) for x in day.split("-"))
    return activity.day_start(datetime(y, m, d, 12, tzinfo=tz), tz, "04:00")


def _merge_days(days: list[dict]) -> dict:
    """activity.summary's per-day rows added up (a late night spans two tracking days)."""
    if len(days) == 1:
        return days[0]
    out: dict = {"attention_seconds": 0, "by_rating": {}, "phone_unlocks": 0, "device_seconds": {},
                 "longest_productive_streak_seconds": 0}
    named: dict[str, dict[str, float]] = {"by_top_category": {}, "top_apps": {}, "top_domains": {}}
    for d in days:
        out["attention_seconds"] += d.get("attention_seconds") or 0
        out["phone_unlocks"] += d.get("phone_unlocks") or 0
        out["longest_productive_streak_seconds"] = max(out["longest_productive_streak_seconds"],
                                                       d.get("longest_productive_streak_seconds") or 0)
        for k in ("by_rating", "device_seconds"):
            for n, v in (d.get(k) or {}).items():
                out[k][n] = out[k].get(n, 0) + v
        for k, acc in named.items():
            for c in d.get(k) or []:
                acc[c["name"]] = acc.get(c["name"], 0) + c["seconds"]
        out["first_active"] = out.get("first_active") or d.get("first_active")
        out["last_active"] = d.get("last_active") or out.get("last_active")
    for k, acc in named.items():
        out[k] = [{"name": n, "seconds": v} for n, v in sorted(acc.items(), key=lambda kv: -kv[1])]
    return out


def bounds(relay, day: str, now: datetime, tz_name: str = TZ) -> dict:
    """Where a tracking day's story starts (its 4 AM, or where the previous day's story ended if that
    ran later), its first activity, and when it verifiably ended (None while it hasn't)."""
    tz = activity.zone(tz_name)
    ds = _day_start(day, tz)
    start = ds
    prev = (ds - timedelta(hours=12)).date().isoformat()
    for st in stories(relay.store, prev):
        if st["slot"] == "end" and st["covers_end"]:
            start = max(start, datetime.fromisoformat(st["covers_end"]))
    scan_end = min(now, ds + LOOK)
    if scan_end <= start:
        return {"start": start, "first_active": None, "ended": None}
    act = activity.activity(relay.aw, {"start": start.isoformat(), "end": scan_end.isoformat(), "tz": tz_name,
                                       "view": "devices", "format": "json"})[1]
    spans: list[list[datetime]] = []
    for seg in sorted(act["segments"], key=lambda x: x["start"]):
        a, b = datetime.fromisoformat(seg["start"]), datetime.fromisoformat(seg["end"])
        if spans and a <= spans[-1][1] + timedelta(seconds=60):
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    evening = datetime(ds.year, ds.month, ds.day, EVENING_HOUR, tzinfo=tz)
    # The first quiet stretch of 2 hours that reaches past 6 PM ends the day, at the activity before it.
    ended, last = None, start
    for a, b in spans + [[scan_end, scan_end]]:
        if a - max(last, evening) >= QUIET:
            ended = last
            break
        last = max(last, b)
    first = spans[0][0] if spans and (ended is None or spans[0][0] < ended) else None
    return {"start": start, "first_active": first, "ended": ended}


def gather(relay, whoop, labeler, day: str, start: datetime, end: datetime, now: datetime | None = None,
           tz_name: str = TZ) -> dict:
    """Everything the story is written from, for [start, end) of one tracking day."""
    now = now or datetime.now(timezone.utc)
    tz = activity.zone(tz_name)
    q = {"tz": tz_name, "start": start.isoformat(), "end": end.isoformat()}
    summ = activity.summary(relay.aw, q)
    d = _merge_days(summ["days"]) if summ["days"] else {}
    act = activity.activity(relay.aw, {**q, "view": "attention", "format": "json", "min_seconds": "20"})[1]
    blocks = claudelog.blocks(relay.aw, relay.store, labeler, q)
    lines = [x for _, x in relay.store.lines("ios", start) if x.get("ts") and _before(x["ts"], end)]
    ratings = d.get("by_rating") or {}
    return {
        "day": day,
        "covers": {"from": start.astimezone(tz).strftime("%a %H:%M"), "to": end.astimezone(tz).strftime("%a %H:%M")},
        "now": now.astimezone(tz).strftime("%a %Y-%m-%d %H:%M"),
        "day_over": end < now - timedelta(minutes=5),
        "totals": {
            "screen_min": round((d.get("attention_seconds") or 0) / 60),
            "by_rating_min": {k: round(v / 60) for k, v in ratings.items()},
            "top_categories": [{"name": c["name"], "min": round(c["seconds"] / 60)} for c in (d.get("by_top_category") or [])[:8]],
            "top_apps": [{"name": c["name"], "min": round(c["seconds"] / 60)} for c in (d.get("top_apps") or [])[:8]],
            "top_sites": [{"name": c["name"], "min": round(c["seconds"] / 60)} for c in (d.get("top_domains") or [])[:8]],
            "device_min": {k: round(v / 60) for k, v in (d.get("device_seconds") or {}).items()},
            "phone_unlocks": d.get("phone_unlocks"),
            "longest_focus_min": round((d.get("longest_productive_streak_seconds") or 0) / 60),
            "first_active": d.get("first_active") and _hm(d["first_active"], tz),
            "last_active": d.get("last_active") and _hm(d["last_active"], tz),
        },
        "stretches": _stretches(act["segments"], tz),
        "claude": [{"from": _hm(b["start"], tz), "to": _hm(b["end"], tz), "min": round(b["seconds"] / 60),
                    "project": b.get("project"), "goal": b.get("goal") or b.get("label"),
                    "kind": b.get("kind"), "verdict": b.get("verdict"), "summary": b.get("summary")}
                   for b in blocks["blocks"]],
        "places": _places(lines, tz),
        "movement": _motion(lines, tz, min(end, now)),
        "phone_locks": _locks(lines, tz),
        "whoop": _whoop(whoop, start, end, tz),
    }


def write(relay, whoop, labeler, slot: str, day: str, start: datetime, end: datetime,
          now: datetime | None = None) -> dict:
    """Writes one story and stores it. Raises labels.ProviderError when every provider failed."""
    inputs = gather(relay, whoop, labeler, day, start, end, now=now)
    user = json.dumps(inputs, ensure_ascii=False)
    last: Exception | None = None
    for prov in labeler.chain:
        if labeler.cooldown.get(prov.name, 0) > time.time():
            continue
        p = prov._replace(model=STORY_MODEL) if prov.name == "anthropic" else prov
        try:
            text, used = labeler.complete(p, SYSTEM, user)
        except labels.ProviderError as e:
            last = e
            labeler.log("day story:", p.name, "failed:", e)
            continue
        text = (text or "").strip()
        if len(text) < 40:
            last = labels.ProviderError(f"{p.name}: answer too short")
            continue
        ensure(relay.store)
        row = (day, slot, time.time(), f"{used.name}/{used.model}", text,
               hashlib.sha256(user.encode()).hexdigest()[:16],
               start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat())
        with relay.store.lock, relay.store.db:
            relay.store.db.execute("INSERT INTO stories (day, slot, created, model, text, inputs, covers_start, "
                                   "covers_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row)
        return {"day": day, "slot": slot, "model": row[3], "text": text}
    raise last or labels.ProviderError("no LLM provider configured")


def write_now(relay, whoop, labeler, day: str, now: datetime | None = None) -> dict:
    """An on-demand story: the day so far, or the whole day if it's over."""
    now = now or datetime.now(timezone.utc)
    b = bounds(relay, day, now)
    end = b["ended"] if b["ended"] and b["ended"] > b["start"] else min(now, b["start"] + LOOK)
    return write(relay, whoop, labeler, "manual", day, b["start"], end, now=now)


def today(now: datetime, tz_name: str = TZ) -> str:
    return activity.day_start(now, activity.zone(tz_name), "04:00").date().isoformat()


def due(relay, now: datetime, tz_name: str = TZ) -> tuple[str, str, datetime, datetime] | None:
    """(day, slot, start, end) of a story that should exist by now and doesn't, else None.
    Yesterday's end story comes first: a late night is still yesterday."""
    tz = activity.zone(tz_name)
    cur = today(now, tz_name)
    prev = (_day_start(cur, tz) - timedelta(hours=12)).date().isoformat()
    for day in (prev, cur):
        have = {s["slot"] for s in stories(relay.store, day)}
        if "end" in have:
            continue
        b = bounds(relay, day, now, tz_name)
        if b["ended"] and b["first_active"]:
            return day, "end", b["start"], b["ended"]
        if (day == cur and not have & {"midday"} and b["first_active"]
                and now >= b["first_active"] + MIDDAY_AFTER):
            return day, "midday", b["start"], now
    return None


def run_forever(relay, whoop, labeler, log=print, every: float = 600) -> None:
    """Writes the midday and end-of-day stories when they come due. A failed one is tried again later."""
    while True:
        time.sleep(every)
        try:
            if relay.aw is None or not labeler.chain:
                continue
            got = due(relay, datetime.now(timezone.utc))
            if got:
                out = write(relay, whoop, labeler, got[1], got[0], got[2], got[3])
                log("day story:", got[0], got[1], "by", out["model"])
        except Exception as e:  # keep trying at the next check
            log("day story failed:", f"{type(e).__name__}: {e}")
            time.sleep(1800)


def start(relay, whoop, labeler, log=print) -> threading.Thread:
    t = threading.Thread(target=run_forever, args=(relay, whoop, labeler, log), daemon=True)
    t.start()
    return t
