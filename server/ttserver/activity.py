"""Analysis-ready activity, computed on the relay the way the dashboard does it.

The dashboard turns ActivityWatch's raw buckets into activity in the browser
(dashboard/src/lib/activity.ts, attention.ts, categories.ts). An agent reading
the relay shouldn't have to redo that, so this is the same pipeline in Python:

- per device, window events kept only while its AFK bucket says not-afk, with
  the browser's tab (URL, page title) attached to browser window time, gaps
  under 5 s closed (ActivityWatch's flood);
- each segment categorized with ActivityWatch's `classes` setting (deepest
  matching rule wins, a later one wins a tie) and rated by its score;
- the merged attention line, using the `tt_attention` setting.

Served as GET /tt/activity (segments) and GET /tt/summary (per-day totals).
"""

from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
from urllib.parse import urlsplit

from .awsync import AW, CLIENT, parse_aw_ts

FLOOD_MS = 5_000
MAX_DAYS = 14
BROWSER = re.compile(r"chrome|msedge|firefox|brave|opera|vivaldi|arc|safari|zen", re.I)
HOME_SCREEN = "Home Screen"
UNCATEGORIZED = "Uncategorized"
DEFAULT_ATTENTION = {"priority": "phone", "backgroundApps": ["Clock", "Spotify", "Music", "Podcasts", "Maps"],
                     "homeScreenCounts": True}
# ActivityWatch's starter categories, used until any are saved (as the dashboard does).
AW_DEFAULT_CLASSES = [
    {"name": ["Work"], "rule": {"type": "regex", "regex": "Google Docs|libreoffice|ReText"}, "data": {"score": 10}},
    {"name": ["Work", "Programming"], "rule": {"type": "regex", "regex": "GitHub|Stack Overflow|BitBucket|Gitlab|vim|Spyder|kate|Ghidra|Scite"}},
    {"name": ["Media"], "rule": {"type": "none"}},
    {"name": ["Media", "Video"], "rule": {"type": "regex", "regex": "YouTube|Plex|VLC"}},
    {"name": ["Media", "Social Media"], "rule": {"type": "regex", "regex": "reddit|Facebook|Twitter|Instagram|devRant", "ignore_case": True}},
    {"name": ["Comms"], "rule": {"type": "none"}},
    {"name": ["Comms", "IM"], "rule": {"type": "regex", "regex": "Messenger|Telegram|Signal|WhatsApp|Slack|Discord"}},
    {"name": ["Comms", "Email"], "rule": {"type": "regex", "regex": "Gmail|Thunderbird"}},
]


@dataclass
class Seg:
    start: int  # epoch ms
    end: int
    device: str = ""
    kind: str = ""  # phone / desktop
    app: str = ""
    title: str = ""
    url: str = ""
    domain: str = ""
    home: bool = False
    confidence: str = ""
    category: str = ""
    rating: str = ""
    score: float | None = None
    extra: dict = field(default_factory=dict)


# ------------------------------------------------------------------ intervals

def flatten(spans: list[Seg], lo: int, hi: int) -> list[Seg]:
    """Clipped to [lo, hi), sorted, overlaps trimmed (each span ends where the next begins)."""
    clipped = []
    for s in spans:
        a, b = max(s.start, lo), min(s.end, hi)
        if b > a:
            clipped.append(_with(s, a, b))
    clipped.sort(key=lambda s: s.start)
    out: list[Seg] = []
    for s in clipped:
        if out and out[-1].end > s.start:
            if out[-1].end > s.end:
                continue
            out[-1] = _with(out[-1], out[-1].start, s.start)
            if out[-1].end <= out[-1].start:
                out.pop()
        out.append(s)
    return out


def flood(spans: list[Seg], gap: int = FLOOD_MS) -> list[Seg]:
    out = []
    for i, s in enumerate(spans):
        nxt = spans[i + 1] if i + 1 < len(spans) else None
        out.append(_with(s, s.start, nxt.start) if nxt and s.end < nxt.start <= s.end + gap else s)
    return out


def intersect(spans: list[Seg], periods: list[Seg]) -> list[Seg]:
    out, j = [], 0
    for s in spans:
        while j < len(periods) and periods[j].end <= s.start:
            j += 1
        k = j
        while k < len(periods) and periods[k].start < s.end:
            a, b = max(s.start, periods[k].start), min(s.end, periods[k].end)
            if b > a:
                out.append(_with(s, a, b))
            k += 1
    return out


def overlay_tabs(spans: list[Seg], tabs: list[Seg]) -> list[Seg]:
    """Split browser window time where tabs change and attach each tab's URL and title."""
    out, j = [], 0
    for s in spans:
        if not BROWSER.search(s.app):
            out.append(s)
            continue
        while j < len(tabs) and tabs[j].end <= s.start:
            j += 1
        t, k = s.start, j
        while k < len(tabs) and tabs[k].start < s.end:
            a, b = max(s.start, tabs[k].start), min(s.end, tabs[k].end)
            k += 1
            if b <= a:
                continue
            if a > t:
                out.append(_with(s, t, a))
            piece = _with(s, a, b)
            tab = tabs[k - 1]
            piece.url, piece.title, piece.domain = tab.url, tab.title or s.title, domain_of(tab.url)
            out.append(piece)
            t = b
        if t < s.end:
            out.append(_with(s, t, s.end))
    return out


def _with(s: Seg, start: int, end: int) -> Seg:
    c = Seg(**{**s.__dict__})
    c.start, c.end = start, end
    return c


def domain_of(url: str) -> str:
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return re.sub(r"^www\.", "", host)


# ------------------------------------------------------------------ devices

@dataclass
class Device:
    host: str
    kind: str
    window: str | None = None
    afk: str | None = None
    web: list[str] = field(default_factory=list)


def discover(buckets: dict[str, dict]) -> list[Device]:
    """As the dashboard's discoverDevices: phones are the relay's buckets; a browser
    extension bucket with no host name goes to the laptop(s)."""
    by_host: dict[str, Device] = {}
    hostless = []
    for b in buckets.values():
        host = b.get("hostname")
        if not host or host == "unknown":
            if b.get("type") == "web.tab.current" and b.get("client") != CLIENT:
                hostless.append(b["id"])
            continue
        d = by_host.setdefault(host, Device(host, "desktop"))
        if b.get("client") == CLIENT:
            d.kind = "phone"
        t = b.get("type")
        if t == "currentwindow":
            d.window = b["id"]
        elif t == "afkstatus":
            d.afk = b["id"]
        elif t == "web.tab.current":
            d.web.append(b["id"])
    devices = [d for d in by_host.values() if d.window]
    for d in devices:
        if d.kind == "desktop":
            d.web += hostless
    return sorted(devices, key=lambda d: (d.kind != "phone", d.host))


def _span(e: dict, **kw) -> Seg:
    start = round(parse_aw_ts(e["timestamp"]).timestamp() * 1000)
    return Seg(start, start + round(float(e["duration"]) * 1000), **kw)


def device_segs(aw: AW, d: Device, lo: int, hi: int) -> tuple[list[Seg], list[Seg]]:
    """(segments of use, not-afk periods) for one device in [lo, hi)."""
    start, end = (datetime.fromtimestamp(x / 1000, timezone.utc) for x in (lo, hi))
    get = (lambda b: aw.events(b, start, end) if b else [])
    win_ev, afk_ev = get(d.window), get(d.afk)
    windows = flood([s for s in flatten([
        _span(e, device=d.host, kind=d.kind, app=_str(e["data"].get("app")), title=_str(e["data"].get("title")),
              home=d.kind == "phone" and e["data"].get("app") == HOME_SCREEN,
              confidence=_str(e["data"].get("tt_confidence")) if d.kind == "phone" else "")
        for e in win_ev], lo, hi) if s.app])
    active = flood(flatten([_span(e) for e in afk_ev if e["data"].get("status") == "not-afk"], lo, hi))
    used = windows if d.kind == "phone" and not afk_ev else intersect(windows, active)
    tabs = flood([t for t in flatten([_span(e, url=_str(e["data"].get("url")), title=_str(e["data"].get("title")))
                                      for b in d.web for e in get(b)], lo, hi) if t.url])
    return overlay_tabs(used, tabs), active


def _str(v) -> str:
    return v if isinstance(v, str) else ""


# ------------------------------------------------------------------ categories

class Categories:
    def __init__(self, defs: list[dict] | None):
        defs = defs if isinstance(defs, list) and defs else AW_DEFAULT_CLASSES
        self.cats: dict[tuple, dict] = {}
        for i, d in enumerate(defs):
            name = tuple(d.get("name") or [])
            if not name:
                continue
            for depth in range(1, len(name)):  # implied parents
                self.cats.setdefault(name[:depth], {"index": i, "rx": None, "own": None})
            rule = d.get("rule") or {}
            score = (d.get("data") or {}).get("score")
            self.cats[name] = {"index": i, "rx": _compile(rule),
                               "own": score if isinstance(score, (int, float)) else None}
        self.memo: dict[tuple, tuple] = {}

    def score(self, name: tuple) -> float | None:
        for depth in range(len(name), 0, -1):
            c = self.cats.get(name[:depth])
            if c and c["own"] is not None:
                return c["own"]
        return None

    def categorize(self, app: str, title: str, url: str) -> tuple[str, float | None, str]:
        key = (app, title, url)
        if key not in self.memo:
            best = None
            for name, c in self.cats.items():
                if c["rx"] and any(f and c["rx"].search(f) for f in key):
                    if best is None or len(name) > len(best[0]) or (
                            len(name) == len(best[0]) and c["index"] >= best[1]["index"]):
                        best = (name, c)
            name = best[0] if best else (UNCATEGORIZED,)
            score = self.score(name)
            rating = "neutral" if not score else "productive" if score > 0 else "distracting"
            self.memo[key] = (" > ".join(name), score, rating)
        return self.memo[key]


def _compile(rule: dict):
    if rule.get("type") != "regex" or not rule.get("regex"):
        return None
    source, flags = rule["regex"], re.I if rule.get("ignore_case") else 0
    if source.startswith("(?i)"):
        source, flags = source[4:], re.I
    try:
        return re.compile(source, flags)
    except re.error:
        return None


# ------------------------------------------------------------------ attention

def merge_attention(phones: list[Seg], desktops: list[Seg], cfg: dict) -> list[Seg]:
    """One line: at each moment, the device that had your attention (attention.ts)."""
    bg = {a.strip().lower() for a in cfg.get("backgroundApps", []) if isinstance(a, str)}
    priority = "desktop" if cfg.get("priority") == "desktop" else "phone"
    home_counts = cfg.get("homeScreenCounts") is not False

    def choose(p, d):
        phone_app = p if p and not p.home and p.app.strip().lower() not in bg else None
        phone_home = p if p and p.home and home_counts else None
        first = (phone_app or d) if priority == "phone" else (d or phone_app)
        return first or phone_home

    phones, desktops = _flatten_all(phones), _flatten_all(desktops)
    points = sorted({x for s in phones + desktops for x in (s.start, s.end)})
    out: list[Seg] = []
    i = j = 0
    for a, b in zip(points, points[1:]):
        while i < len(phones) and phones[i].end <= a:
            i += 1
        while j < len(desktops) and desktops[j].end <= a:
            j += 1
        p = phones[i] if i < len(phones) and phones[i].start <= a else None
        d = desktops[j] if j < len(desktops) and desktops[j].start <= a else None
        pick = choose(p, d)
        if not pick:
            continue
        prev = out[-1] if out else None
        if prev and prev.end == a and (prev.device, prev.app, prev.title, prev.url) == (
                pick.device, pick.app, pick.title, pick.url):
            prev.end = b
        else:
            out.append(_with(pick, a, b))
    return out


def _flatten_all(spans: list[Seg]) -> list[Seg]:
    out: list[Seg] = []
    for s in sorted(spans, key=lambda s: s.start):
        if out and s.start < out[-1].end:
            if s.end > out[-1].end:
                out.append(_with(s, out[-1].end, s.end))
        else:
            out.append(s)
    return out


# ------------------------------------------------------------------ queries

def zone(name: str | None) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name or "America/Los_Angeles")
    except Exception:
        raise ValueError(f"unknown time zone {name!r} (use an IANA name like America/Los_Angeles)") from None


def parse_range(q: dict[str, str], tz: tzinfo, start_of_day: str, now: datetime) -> tuple[datetime, datetime]:
    """start/end (ISO; a bare date is that day's start in tz), or days=N whole days ending today."""
    def parse(v: str) -> datetime:
        v = v.strip().replace(" ", "+") if "T" in v else v.strip()
        try:
            t = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError(f"bad time {v!r}: use ISO 8601, e.g. 2026-11-01 or 2026-11-01T09:00:00-07:00") from None
        if len(v) <= 10:  # a date: that day's start
            t = day_start(t.replace(tzinfo=tz, hour=12), tz, start_of_day)
        return t if t.tzinfo else t.replace(tzinfo=tz)

    if q.get("start"):
        start = parse(q["start"])
        end = parse(q["end"]) if q.get("end") else now
        if q.get("end") and len(q["end"].strip()) <= 10:
            end = day_start(end + timedelta(hours=36), tz, start_of_day)  # a date as end: through that day
    else:
        days = float(q.get("days", 1))
        end = now
        start = day_start(now, tz, start_of_day) - timedelta(days=max(days, 1) - 1)
        start = day_start(start + timedelta(hours=12), tz, start_of_day)
    end = min(end, now + timedelta(minutes=1))
    if end <= start:
        raise ValueError("end must be after start")
    if end - start > timedelta(days=MAX_DAYS, hours=2):
        raise ValueError(f"at most {MAX_DAYS} days per request; ask for longer spans in pieces")
    return start, end


def day_start(t: datetime, tz: tzinfo, start_of_day: str) -> datetime:
    """Start of the tracking day containing t ("HH:MM" after local midnight, 04:00 by default)."""
    m = re.match(r"^(\d{1,2}):(\d{2})$", start_of_day or "")
    off = timedelta(hours=int(m[1]), minutes=int(m[2])) if m else timedelta(hours=4)
    local = (t.astimezone(tz) - off)
    midnight = datetime(local.year, local.month, local.day, tzinfo=tz)
    return (midnight + off).astimezone(tz)


class Snapshot:
    """Everything for one range: settings, devices, segments, attention line."""

    def __init__(self, aw: AW, q: dict[str, str], now: datetime | None = None):
        now = now or datetime.now(timezone.utc)
        settings = aw._req("GET", "/settings") or {}
        self.tz = zone(q.get("tz"))
        self.start_of_day = settings.get("startOfDay") if isinstance(settings.get("startOfDay"), str) else "04:00"
        self.start, self.end = parse_range(q, self.tz, self.start_of_day, now)
        lo, hi = round(self.start.timestamp() * 1000), round(self.end.timestamp() * 1000)
        cats = Categories(settings.get("classes"))
        att = settings.get("tt_attention")
        self.attention_cfg = {**DEFAULT_ATTENTION, **(att if isinstance(att, dict) else {})}
        self.devices = discover(aw.buckets())
        self.per_device: dict[str, list[Seg]] = {}
        self.active: dict[str, list[Seg]] = {}
        for d in self.devices:
            segs, active = device_segs(aw, d, lo, hi)
            for s in segs:
                s.category, s.score, s.rating = cats.categorize(s.app, s.title, s.url)
            self.per_device[d.host], self.active[d.host] = segs, active
        kind = {d.host: d.kind for d in self.devices}
        self.attention = merge_attention(
            [s for h, l in self.per_device.items() if kind[h] == "phone" for s in l],
            [s for h, l in self.per_device.items() if kind[h] == "desktop" for s in l], self.attention_cfg)

    def iso(self, ms: int) -> str:
        return datetime.fromtimestamp(ms / 1000, self.tz).isoformat(timespec="seconds")

    def meta(self) -> dict:
        return {"start": self.start.isoformat(timespec="seconds"), "end": self.end.isoformat(timespec="seconds"),
                "tz": str(self.tz), "start_of_day": self.start_of_day, "attention_rules": self.attention_cfg,
                "devices": [{"host": d.host, "kind": d.kind} for d in self.devices]}

    def rows(self, segs: list[Seg]) -> list[dict]:
        return [{"start": self.iso(s.start), "end": self.iso(s.end), "seconds": round((s.end - s.start) / 1000, 1),
                 "device": s.device, "kind": s.kind, "app": s.app, "title": s.title, "url": s.url,
                 "domain": s.domain, "category": s.category, "rating": s.rating, "score": s.score,
                 "confidence": s.confidence} for s in segs]


COLUMNS = ["start", "end", "seconds", "device", "kind", "app", "title", "url", "domain", "category", "rating",
           "score", "confidence"]


def activity(aw: AW, q: dict[str, str]) -> tuple[str, object]:
    """GET /tt/activity: (content type, body)."""
    snap = Snapshot(aw, q)
    view = q.get("view", "attention")
    if view == "attention":
        segs = snap.attention
    elif view == "devices":
        segs = sorted((s for l in snap.per_device.values() for s in l), key=lambda s: (s.start, s.device))
    else:
        raise ValueError("view is attention or devices")
    min_s = float(q.get("min_seconds", 0))
    rows = [r for r in snap.rows(segs) if r["seconds"] >= min_s]
    if q.get("format") == "csv":
        buf = io.StringIO()
        w = csv.DictWriter(buf, COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
        return "text/csv; charset=utf-8", buf.getvalue()
    return "application/json", {**snap.meta(), "view": view, "count": len(rows), "segments": rows}


def summary(aw: AW, q: dict[str, str]) -> dict:
    """GET /tt/summary: per tracking day, totals of the attention line and device use."""
    if not q.get("start") and "days" not in q:
        q = {**q, "days": "7"}
    snap = Snapshot(aw, q)
    top_n = int(q.get("top", 10))
    days: dict[str, dict] = {}

    def day_of(ms: int) -> tuple[str, int]:
        """The tracking day containing ms, and the next day's start (ms)."""
        ds = day_start(datetime.fromtimestamp(ms / 1000, timezone.utc), snap.tz, snap.start_of_day)
        nxt = day_start(ds + timedelta(hours=30), snap.tz, snap.start_of_day)
        return ds.date().isoformat(), round(nxt.timestamp() * 1000)

    def pieces(segs: list[Seg]):
        """Segments split at day boundaries, with their day."""
        for s in segs:
            a = s.start
            while a < s.end:
                day, nxt = day_of(a)
                b = min(s.end, nxt)
                yield day, s, (b - a) / 1000, a
                a = b

    def acc():
        return {"attention_seconds": 0.0, "by_rating": defaultdict(float), "by_top_category": defaultdict(float),
                "by_category": defaultdict(float), "by_device_kind": defaultdict(float), "apps": defaultdict(float),
                "domains": defaultdict(float), "first_active": None, "last_active": None,
                "device_seconds": defaultdict(float), "phone_unlocks": 0, "longest_productive_streak_seconds": 0.0}

    for day, s, secs, a in pieces(snap.attention):
        d = days.setdefault(day, acc())
        d["attention_seconds"] += secs
        d["by_rating"][s.rating] += secs
        d["by_category"][s.category] += secs
        d["by_top_category"][s.category.split(" > ")[0]] += secs
        d["by_device_kind"][s.kind] += secs
        d["apps"][s.app] += secs
        if s.domain:
            d["domains"][s.domain] += secs
        t0, t1 = snap.iso(a), snap.iso(a + round(secs * 1000))
        d["first_active"] = d["first_active"] or t0
        d["last_active"] = t1
    for host, segs in snap.per_device.items():
        for day, s, secs, _ in pieces(segs):
            days.setdefault(day, acc())["device_seconds"][host] += secs
    phones = {d.host for d in snap.devices if d.kind == "phone"}
    for host in phones:
        for p in snap.active[host]:
            if snap.start.timestamp() * 1000 < p.start:  # an unlock that began in range
                days.setdefault(day_of(p.start)[0], acc())["phone_unlocks"] += 1
    # Longest run of productive attention with breaks under 2 minutes.
    run_start = run_end = None
    for s in snap.attention:
        if s.rating != "productive":
            continue
        if run_end is not None and s.start - run_end <= 120_000:
            run_end = s.end
        else:
            run_start, run_end = s.start, s.end
        day = day_of(run_start)[0]
        if day in days:
            days[day]["longest_productive_streak_seconds"] = max(
                days[day]["longest_productive_streak_seconds"], (run_end - run_start) / 1000)

    def ranked(m: dict, n: int | None = None) -> list:
        items = sorted(m.items(), key=lambda kv: -kv[1])
        return [{"name": k, "seconds": round(v)} for k, v in (items[:n] if n else items)]

    out = []
    for day in sorted(days):
        d = days[day]
        out.append({"day": day, "attention_seconds": round(d["attention_seconds"]),
                    "first_active": d["first_active"], "last_active": d["last_active"],
                    "by_rating": {k: round(v) for k, v in d["by_rating"].items()},
                    "by_top_category": ranked(d["by_top_category"]), "by_category": ranked(d["by_category"]),
                    "by_device_kind": {k: round(v) for k, v in d["by_device_kind"].items()},
                    "device_seconds": {k: round(v) for k, v in d["device_seconds"].items()},
                    "top_apps": ranked(d["apps"], top_n), "top_domains": ranked(d["domains"], top_n),
                    "phone_unlocks": d["phone_unlocks"],
                    "longest_productive_streak_seconds": round(d["longest_productive_streak_seconds"])})
    return {**snap.meta(), "days": out}
