"""Write the fused timeline into ActivityWatch, as a watcher for the phone.

ActivityWatch has no watcher base class: a watcher is any process that creates
its buckets and posts events over the REST API. This one keeps, per device,
the same buckets the desktop watchers do, so the web UI treats the phone like
any other host:

    aw-watcher-window_<host>       currentwindow    {app, title}
    aw-watcher-afk_<host>          afkstatus        {status: afk / not-afk}
    aw-watcher-web-safari_<host>   web.tab.current  {url, title, audible, incognito}

Fusion revises recent history as late lines arrive (locked stretches reach the
server only after the unlock, and the live tail is provisional), so instead
of appending, reconcile() makes the bucket's events from `since` on equal to
the desired ones: it deletes what is no longer wanted and inserts what is new.
Running it twice changes nothing.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .fusion import Interval
from .web import Page, split_safari

CLIENT = "tt-relay"


def hostname(dev: str) -> str:
    """AW rejects hostnames with whitespace; bucket ids go in URLs."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", dev).strip("-") or "iphone"


def _ms(ts: datetime) -> int:
    return round(ts.timestamp() * 1000)


def event(start: datetime, end: datetime, data: dict) -> dict:
    return {"timestamp": start.astimezone(timezone.utc).isoformat(),
            "duration": (end - start).total_seconds(), "data": data}


def parse_aw_ts(value: str) -> datetime:
    """AW timestamps may carry more than the 6 fractional digits Python reads."""
    value = re.sub(r"(\.\d{6})\d+", r"\1", value.replace("Z", "+00:00"))
    return datetime.fromisoformat(value)


def event_key(e: dict) -> tuple:
    start = parse_aw_ts(e["timestamp"])
    return (_ms(start), round(float(e["duration"]) * 1000), json.dumps(e["data"], sort_keys=True))


class AW:
    def __init__(self, base: str = "http://127.0.0.1:5600", api_key: str | None = None, timeout: float = 15):
        self.base = base.rstrip("/") + "/api/0"
        self.api_key = api_key
        self.timeout = timeout
        # aw-server bound to localhost only accepts a localhost Host header.
        self.local = urllib.parse.urlsplit(base).hostname in ("127.0.0.1", "localhost")

    def _req(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if self.local:
            req.add_header("Host", "localhost:5600")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as e:
            if e.code == 304:  # bucket already exists
                return None
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read()[:300]!r}") from None
        return json.loads(raw) if raw.strip() else None

    def info(self):
        return self._req("GET", "/info")

    def buckets(self) -> dict[str, dict]:
        return self._req("GET", "/buckets/") or {}

    def ensure_bucket(self, bucket_id: str, type_: str, host: str, client: str = CLIENT) -> None:
        self._req("POST", f"/buckets/{urllib.parse.quote(bucket_id)}",
                  {"client": client, "type": type_, "hostname": host})

    def events(self, bucket_id: str, start: datetime, end: datetime) -> list[dict]:
        q = urllib.parse.urlencode({"start": start.astimezone(timezone.utc).isoformat(),
                                    "end": end.astimezone(timezone.utc).isoformat(), "limit": -1})
        return self._req("GET", f"/buckets/{urllib.parse.quote(bucket_id)}/events?{q}") or []

    def insert(self, bucket_id: str, events: list[dict]) -> None:
        for k in range(0, len(events), 1000):  # keeps each request well under the relay's body limit
            self._req("POST", f"/buckets/{urllib.parse.quote(bucket_id)}/events", events[k:k + 1000])

    def delete(self, bucket_id: str, event_id: int) -> None:
        self._req("DELETE", f"/buckets/{urllib.parse.quote(bucket_id)}/events/{event_id}")

    def reconcile(self, bucket_id: str, desired: list[dict], since: datetime, until: datetime) -> tuple[int, int]:
        """Make the bucket's events starting in [since, until] equal `desired`
        (filtered to the same range), and return (inserted, deleted)."""
        lo, hi = _ms(since), _ms(until)
        keys = [(event_key(e), e) for e in desired]
        # A desired event that starts before `since` but reaches into it (a
        # long not-afk span, say) is still changing: widen the range to it.
        lo = min([lo] + [k[0] for k, _ in keys if k[0] < lo < k[0] + k[1]])
        want = {k: e for k, e in keys if lo <= k[0] <= hi}
        start = datetime.fromtimestamp(lo / 1000, timezone.utc)
        have = [e for e in self.events(bucket_id, start, until) if lo <= event_key(e)[0] <= hi]
        deleted = 0
        for e in have:
            k = event_key(e)
            if k in want:
                del want[k]  # already there
            else:
                self.delete(bucket_id, e["id"])
                deleted += 1
        self.insert(bucket_id, sorted(want.values(), key=lambda e: e["timestamp"]))
        return len(want), deleted


def device_events(intervals: list[Interval], pages: list[Page]) -> dict[str, list[dict]]:
    """The fused intervals of one device as AW events, by bucket kind."""
    window, afk, web = [], [], []
    for iv, page in split_safari(intervals, pages):
        tag = {"tt_confidence": iv.confidence}
        if iv.state == "locked":
            afk.append(event(iv.start, iv.end, {"status": "afk"}))
            continue
        afk.append(event(iv.start, iv.end, {"status": "not-afk"}))
        app = iv.app if iv.state == "app" else "Home Screen"
        title = page.title if page else ""
        window.append(event(iv.start, iv.end, {"app": app, "title": title, **tag}))
        if page:
            web.append(event(iv.start, iv.end, {"url": page.url, "title": page.title,
                                                "audible": False, "incognito": False, **tag}))
    return {"window": _merge(window), "afk": _merge(afk), "web": _merge(web)}


def _merge(events: list[dict]) -> list[dict]:
    """Join back-to-back events with identical data, e.g. the not-afk spans of
    consecutive apps."""
    out: list[dict] = []
    for e in events:
        if out and out[-1]["data"] == e["data"]:
            prev = out[-1]
            prev_end = parse_aw_ts(prev["timestamp"]).timestamp() + prev["duration"]
            start = parse_aw_ts(e["timestamp"]).timestamp()
            if abs(start - prev_end) < 0.001:
                prev["duration"] = round(prev["duration"] + e["duration"], 6)
                continue
        out.append(dict(e))
    return out


BUCKETS = {
    "window": ("aw-watcher-window_{}", "currentwindow"),
    "afk": ("aw-watcher-afk_{}", "afkstatus"),
    "web": ("aw-watcher-web-safari_{}", "web.tab.current"),
}


def sync_device(aw: AW, dev: str, intervals: list[Interval], pages: list[Page],
                since: datetime, until: datetime) -> dict[str, tuple[int, int]]:
    host = hostname(dev)
    result = {}
    for kind, events in device_events(intervals, pages).items():
        pattern, type_ = BUCKETS[kind]
        bucket = pattern.format(host)
        aw.ensure_bucket(bucket, type_, host)
        result[bucket] = aw.reconcile(bucket, events, since, until)
    return result
