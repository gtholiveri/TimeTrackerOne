"""Turn the Safari extension's page events into "which page was on screen".

The content script reports, for each page: when it becomes visible or hidden,
URL and title changes (including single-page-app navigation), and a beat every
15 s while visible. A page counts as on screen from its first visible line
until it is hidden, another page shows, or its beats stop. Those segments are
then clipped to the times the phone had Safari in the foreground (from
fusion.fuse), since a page can't tell when the phone locks or Safari leaves the
screen.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from .fusion import Interval
from .lines import parse_ts

BEAT = 15     # the content script's beat while visible
STALE = 40    # no line from the visible page for this long: it's gone
SAFARI_APPS = {"Safari"}
HIDE_KINDS = {"hide", "pagehide", "unload"}


@dataclass(frozen=True)
class Page:
    start: datetime
    end: datetime
    url: str
    title: str


def web_segments(lines: list[dict], now: datetime) -> list[Page]:
    events = sorted(((parse_ts(d.get("ts")), d) for d in lines), key=lambda e: e[0] or now)
    out: list[Page] = []
    cur = None  # [page id, url, title, start, last seen]

    def close(at):
        nonlocal cur
        if cur and at > cur[3]:
            out.append(Page(cur[3], at, cur[1], cur[2]))
        cur = None

    for ts, d in events:
        if ts is None:
            continue
        if cur and (ts - cur[4]).total_seconds() > STALE:
            close(cur[4] + timedelta(seconds=BEAT))
        page, url, title = d.get("page"), d.get("url") or "", d.get("title") or ""
        visible = d.get("vis") == "visible" and d.get("kind") not in HIDE_KINDS
        if visible:
            if cur and cur[0] == page and cur[1] == url and cur[2] == title:
                cur[4] = ts
            else:
                close(ts)
                cur = [page, url, title, ts, ts]
        elif cur and cur[0] == page:
            close(ts)
    if cur:
        close(min(now, cur[4] + timedelta(seconds=STALE)))
    return out


def split_safari(intervals: list[Interval], pages: list[Page]) -> list[tuple[Interval, Page | None]]:
    """Each interval paired with the page on screen; Safari intervals are cut at
    page boundaries. Non-Safari intervals and uncovered Safari time get None."""
    out = []
    for iv in intervals:
        if iv.state != "app" or iv.app not in SAFARI_APPS:
            out.append((iv, None))
            continue
        t = iv.start
        for p in pages:
            if p.end <= t or p.start >= iv.end:
                continue
            s, e = max(p.start, t), min(p.end, iv.end)
            if s > t:
                out.append((replace(iv, start=t, end=s), None))
            out.append((replace(iv, start=s, end=e), p))
            t = e
        if t < iv.end:
            out.append((replace(iv, start=t), None))
    return out
