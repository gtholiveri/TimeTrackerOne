"""Fuse the iPhone's two log streams into one timeline of what the phone was doing.

The two streams (docs/fusion.md has the evidence behind every rule):

- Watcher (TT Watch): polls Device Is Locked and Get Current App every ~2.3 s
  and logs a line whenever either changes (kind=change), plus a heartbeat about
  every 6 minutes (kind=beat), and start/end of each run. While the phone is
  locked it can't write, so locked lines arrive after the next unlock, each with
  its own timestamp.
- Automations (TT App Opened / TT App Closed): one line the moment an app opens
  or closes (kind=open/close). Locking the phone fires a close; unlocking
  straight back into the same app fires nothing. Swiping from one app to the
  next fires a close and no open.

The watcher says *what* the phone is doing to within one tick; the automations
say exactly *when* an app opened or closed, but can't see an unlock or tell the
Home Screen from the Lock Screen. fuse():
1. builds the watcher's timeline and moves each of its transitions to the
   automation event that caused it;
2. builds a second timeline from the automations alone, guessing Home Screen
   or locked after each close from how long it was until the next open;
3. uses the watcher wherever it has data, and the automation timeline
   everywhere else: while the watcher wasn't running, and after its newest
   line (the server always hears about an app opening before the watcher's
   line for it arrives);
4. extends the newest state to `now` as provisional. It gets corrected when
   more data arrives.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

TICK = 2.5          # watcher poll period, a little over the ~2.3 s measured
SNAP = TICK + 1.5   # an automation event this far before a watcher change can be that change
SILENCE = 900       # heartbeat is every ~345 s; a longer gap means the watcher wasn't running
HOME_MAX = 20       # close, then the next open within this many seconds: Home Screen; later: locked
LOCK_INFER = 6      # a close with nothing after it, older than this: locked (see automation_timeline)
PROVISIONAL_MAX = timedelta(hours=3)          # longest an app or Home Screen state is assumed to last
PROVISIONAL_LOCKED_MAX = timedelta(hours=24)  # same, for locked

WATCHER_KINDS = {"start", "change", "beat", "end", "poll"}
AUTOMATION_KINDS = {"open", "close"}


@dataclass(frozen=True)
class Record:
    ts: datetime
    kind: str
    dev: str = "iphone"
    locked: str | None = None   # "Yes" / "No"
    cur: str | None = None      # Get Current App: app name, "" on the Home Screen
    input: str | None = None    # what the automation passed in
    run: str | None = None

    @property
    def watcher(self) -> bool:
        return self.kind in WATCHER_KINDS

    @property
    def app_identity(self) -> str | None:
        """For automation events: which app opened/closed."""
        for v in (self.input, self.cur):
            if v and v.strip():
                return v.strip()
        return None


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime
    state: str          # "app", "home" or "locked"
    app: str | None = None
    # exact: the transition into it is an automation event; tick: from the
    # watcher, within one tick; session: an app's open..close from the
    # automations; inferred: Home Screen or locked, guessed from the gap after
    # a close; provisional: still ongoing, extended to now.
    confidence: str = "tick"

    @property
    def seconds(self) -> float:
        return (self.end - self.start).total_seconds()

    def same_activity(self, other: Interval) -> bool:
        return self.state == other.state and self.app == other.app


def cap(state: str) -> timedelta:
    return PROVISIONAL_LOCKED_MAX if state == "locked" else PROVISIONAL_MAX


def record_state(r: Record) -> tuple[str, str | None] | None:
    """The phone state a watcher line reports, or None if it reports none."""
    if r.kind not in ("change", "beat", "poll") or r.locked is None:
        return None
    if r.locked == "Yes":
        return ("locked", None)
    if r.locked != "No":
        return None  # the Is Locked read failed
    app = (r.cur or "").strip()
    return ("app", app) if app else ("home", None)


def swipe_target(e: Record, left: str | None) -> str | None:
    """If close `e` is a swipe out of app `left`, the app it swiped to; else None.

    Swiping along the bottom edge from one app to the next fires a close for
    the app left, and no open for the next one. By the time the close's
    shortcut runs, Get Current App (`e.cur`) already names the next app. The
    automation passes no input on the phone today, so `e.input` is empty.
    """
    if e.kind != "close":
        return None
    cur = (e.cur or "").strip()
    left = (left or "").strip()
    if not cur or cur == left:
        return None  # Home Screen or app switcher; or a lock, where Get Current App keeps the last app
    if e.input and e.input.strip() and e.input.strip() != left:
        return None  # iOS named the app that closed, and it isn't this one: a late echo
    return cur


# ---------------------------------------------------------------- watcher timeline

def watcher_segments(records: list[Record]) -> list[Interval]:
    """Intervals reported by the watcher alone, transitions at line timestamps.
    The newest state, if the watcher didn't end, is left open (confidence
    "open", ending at the watcher's last line)."""
    out: list[Interval] = []
    state = None        # (state, app) currently in force
    since = None        # when it started
    last_seen = None    # timestamp of the last watcher line
    for r in records:
        if not r.watcher:
            continue
        if last_seen is not None and (r.ts - last_seen).total_seconds() > SILENCE:
            # The watcher wasn't running: close the open state one tick after its last line.
            if state is not None:
                out.append(Interval(since, last_seen + timedelta(seconds=TICK), *state))
            state = since = None
        last_seen = r.ts
        if r.kind == "end":
            if state is not None:
                out.append(Interval(since, r.ts, *state))
            state = since = None
            continue
        new = record_state(r)
        if new is None or new == state:
            continue
        if state is not None:
            out.append(Interval(since, r.ts, *state))
        state, since = new, r.ts
    if state is not None:
        out.append(Interval(since, last_seen, *state, confidence="open"))
    return [i for i in out if i.seconds > 0 or i.confidence == "open"]


def snap_to_automations(segs: list[Interval], events: list[Record]) -> list[Interval]:
    """Move watcher transitions to the automation event that caused them."""
    if not segs or not events:
        return segs
    segs = list(segs)
    for k in range(1, len(segs)):
        prev, nxt = segs[k - 1], segs[k]
        if prev.end != nxt.start:
            continue  # a gap, not a transition
        t = nxt.start
        window = [e for e in events
                  if t - timedelta(seconds=SNAP) <= e.ts <= t + timedelta(seconds=0.5)
                  and prev.start < e.ts]
        if not window:
            continue
        pick = None
        if nxt.state == "app":
            opens = [e for e in window if e.kind == "open" and e.app_identity == nxt.app]
            pick = opens[-1] if opens else None
        if pick is None and (prev.state == "app" or nxt.state in ("locked", "home")):
            closes = [e for e in window if e.kind == "close"
                      and (prev.state != "app" or e.app_identity in (None, prev.app) or nxt.state == "locked"
                           or nxt.state == "app" and swipe_target(e, prev.app) == nxt.app)]
            pick = closes[-1] if closes else None
        if pick is None:
            continue
        segs[k - 1] = replace(prev, end=pick.ts)
        segs[k] = replace(nxt, start=pick.ts, confidence="exact" if nxt.confidence != "open" else "open")
    return segs


def close_open_segment(segs: list[Interval], events: list[Record], now: datetime) -> list[Interval]:
    """End the watcher's open last state at the first automation event after
    its last line (the automation timeline takes over from there), or extend
    it to now if there is none."""
    if not segs or segs[-1].confidence != "open":
        return segs
    last = segs[-1]
    nxt = next((e for e in transitions(events) if e.ts > last.end), None)
    if nxt is not None:
        closed = replace(last, end=nxt.ts, confidence="tick")
    else:
        closed = replace(last, end=min(now, last.start + cap(last.state)), confidence="provisional")
    return segs[:-1] + ([closed] if closed.seconds > 0 else [])


# ---------------------------------------------------------------- automation timeline

def transitions(events: list[Record]) -> list[Record]:
    """The automation events that change the state: opens, and closes that
    aren't half of an app switch (a close followed by an open within SNAP)."""
    return [e for k, e in enumerate(events)
            if e.kind == "open" and e.app_identity
            or e.kind == "close" and not any(o.kind == "open" and 0 <= (o.ts - e.ts).total_seconds() <= SNAP
                                             for o in events[k + 1:k + 3])]


def automation_timeline(events: list[Record], now: datetime) -> list[Interval]:
    """The timeline the automations alone imply.

    open(X): X from then on. A close followed by an open within SNAP is an app
    switch, and the open does the work. A close that is a swipe to X (see
    swipe_target) counts like open(X). Any other close of the current app
    means the Home Screen if the next open came within HOME_MAX, and locked
    otherwise (the Lock Screen and Home Screen look the same to automations).
    The newest close counts as locked once it's LOCK_INFER old: had the phone
    been unlocked, the next app open would have synced by then. The last state
    runs to now, provisional.
    """
    evs = transitions(events)
    out: list[Interval] = []
    state = since = None
    for k, e in enumerate(evs):
        if e.kind == "open":
            new = ("app", e.app_identity)
        elif state and state[0] == "app" and (to := swipe_target(e, state[1])):
            new = ("app", to)  # a swipe: the close of one app, and no open for the next
        else:
            if state and state[0] == "app" and e.app_identity not in (None, state[1]):
                continue  # the late close of an app already left
            later = evs[k + 1].ts if k + 1 < len(evs) else None
            gap = ((later or now) - e.ts).total_seconds()
            new = ("home", None) if gap <= (HOME_MAX if later else LOCK_INFER) else ("locked", None)
        if new == state:
            continue
        if state is not None:
            end = min(e.ts, since + cap(state[0]))
            out.append(Interval(since, end, *state, "session" if state[0] == "app" else "inferred"))
        state, since = new, e.ts
    if state is not None:
        out.append(Interval(since, min(now, since + cap(state[0])), *state, "provisional"))
    return [i for i in out if i.seconds > 0]


def subtract(intervals: list[Interval], covered: list[tuple[datetime, datetime]]) -> list[Interval]:
    """The parts of `intervals` not inside any `covered` span."""
    out = []
    for iv in intervals:
        pieces = [(iv.start, iv.end)]
        for a, b in covered:
            nxt = []
            for s, e in pieces:
                if e <= a or s >= b:
                    nxt.append((s, e))
                    continue
                if s < a:
                    nxt.append((s, a))
                if e > b:
                    nxt.append((b, e))
            pieces = nxt
        out += [replace(iv, start=s, end=e) for s, e in pieces if e > s]
    return out


# ---------------------------------------------------------------- main entry

def merge_adjacent(intervals: list[Interval]) -> list[Interval]:
    out: list[Interval] = []
    for iv in sorted(intervals, key=lambda i: i.start):
        if iv.seconds <= 0:
            continue
        if out and out[-1].same_activity(iv) and abs((iv.start - out[-1].end).total_seconds()) < 0.001:
            prev = out[-1]
            conf = "provisional" if iv.confidence == "provisional" else prev.confidence
            out[-1] = replace(prev, end=max(prev.end, iv.end), confidence=conf)
        else:
            out.append(iv)
    return out


def fuse(records: list[Record], now: datetime) -> list[Interval]:
    """One device's records (any order) -> non-overlapping intervals, oldest first."""
    records = sorted(records, key=lambda r: r.ts)
    events = [r for r in records if r.kind in AUTOMATION_KINDS]
    segs = watcher_segments(records)
    segs = snap_to_automations(segs, events)
    segs = close_open_segment(segs, events, now)
    covered = [(s.start, s.end) for s in segs]
    fill = subtract(automation_timeline(events, now), covered)
    return merge_adjacent(segs + fill)
