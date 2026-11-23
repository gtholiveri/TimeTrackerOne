"""What the relay has received, per local day: the answer to "has data been
coming in?" without pulling every raw line.

For each day: line counts per source and kind (phone open/close, TT Watch
start/change/beat/end, loc/visit/locpause, motion; Safari records), the
devices seen, and the newest line. Plus every TT Watch run (run id, device,
first and last line, how many lines, whether it reached its end line), which
shows when the watcher was running and when iOS stopped it.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from .activity import zone
from .lines import parse_line

WATCH_KINDS = ("start", "change", "beat", "end")


def coverage(store, days: float = 7, tz: str = "America/Los_Angeles", now: datetime | None = None) -> dict:
    tzone = zone(tz)
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    per_day: dict[str, dict] = {}
    runs: dict[str, dict] = {}
    last_received: dict[str, float] = {}

    def day(ts: datetime) -> dict:
        key = ts.astimezone(tzone).date().isoformat()
        return per_day.setdefault(key, {"day": key, "ios": defaultdict(int), "safari": 0, "devices": set(),
                                        "newest": None})

    for source in ("ios", "safari"):
        for dev, ts_text, raw, received in store.rows(source, since):
            try:
                ts = datetime.fromisoformat(ts_text.replace("Z", "+00:00"))
            except (TypeError, ValueError):
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            d = day(ts)
            local = ts.astimezone(tzone).isoformat(timespec="seconds")
            d["newest"] = max(d["newest"] or local, local)
            last_received[source] = max(last_received.get(source, 0), received or 0)
            if source == "safari":
                d["safari"] += 1
                continue
            parsed = parse_line(raw) or {}
            kind = parsed.get("kind") or "?"
            d["ios"][kind] += 1
            if dev:
                d["devices"].add(dev)
            if kind in WATCH_KINDS and parsed.get("run"):
                r = runs.setdefault(parsed["run"], {"run": parsed["run"], "dev": dev, "first": local, "last": local,
                                                    "lines": 0, "ended": False})
                r["first"], r["last"] = min(r["first"], local), max(r["last"], local)
                r["lines"] += 1
                r["ended"] = r["ended"] or kind == "end"

    out_days = []
    for key in sorted(per_day):
        d = per_day[key]
        out_days.append({"day": key, "ios": dict(sorted(d["ios"].items())), "ios_total": sum(d["ios"].values()),
                         "safari": d["safari"], "devices": sorted(d["devices"]), "newest": d["newest"]})
    watch = sorted(runs.values(), key=lambda r: r["first"])
    for r in watch:
        r["hours"] = round((datetime.fromisoformat(r["last"]) - datetime.fromisoformat(r["first"])).total_seconds()
                           / 3600, 2)
    return {"tz": tz, "since": since.astimezone(tzone).isoformat(timespec="seconds"),
            "now": now.astimezone(tzone).isoformat(timespec="seconds"),
            "last_received": {k: datetime.fromtimestamp(v, timezone.utc).astimezone(tzone).isoformat(timespec="seconds")
                              for k, v in last_received.items() if v},
            "days": out_days, "watch_runs": watch}
