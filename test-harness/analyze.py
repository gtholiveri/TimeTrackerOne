#!/usr/bin/env python3
"""Analyze logs from the empirical tests (stdlib only).

Reads JSON-lines files written by receiver.py and/or the on-device file the test
shortcuts append to (tt-log.jsonl), merges and de-duplicates them, and prints:

  summary   record counts per file/kind, and records present in only one file
            (on-device log vs receiver = what the network lost)
  timeline  every record in time order, grouped under the markers you typed
  sessions  open/close pairing: exact sessions, closes with no matching open
            (the unlock-straight-into-an-app case) and how poll samples bound
            them, opens that never closed, and time with no app open
  closecur  on "close" events, does Get Current App report the closing app or
            the app you switched to? (T2)
  runs      polling-loop lifetimes and tick gaps, per run id (T4, T10 bg ticks)
  apps      every distinct value Get Current App returned (T1)
  latency   receive time minus device timestamp
  safari    which Safari probe signals arrived, and per-page sequence gaps (T10)

Examples:
  python3 analyze.py logs/day1.jsonl tt-log.jsonl
  python3 analyze.py logs/*.jsonl --section sessions --section runs
  python3 analyze.py logs/day1.jsonl --since 2026-09-25T14:00 --until 2026-09-25T15:00
  python3 analyze.py example-log.jsonl        # see what the output looks like

Record fields used (anything else is shown but ignored):
  kind   open | close | poll | poll.end | marker | probe | safari.*
  ts     device timestamp, ISO-8601 (or unix seconds); rx is the receiver's time
  app / input / cur   app identity: explicit, Shortcut Input, Get Current App
  run, tick, ctx      polling-loop run id, repeat index, free-text context
  note                marker text
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

SECTIONS = ["summary", "timeline", "sessions", "closecur", "runs", "apps", "latency", "safari"]
LOCAL_TZ = datetime.now().astimezone().tzinfo
CURLY_QUOTES = str.maketrans({"\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2033": '"'})


# ---------------------------------------------------------------- loading

def parse_ts(value) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"\d{9,}(\.\d+)?", value.strip())):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip().replace(",", ".")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # "+0200" -> "+02:00" (some date formatters omit the colon)
    m = re.match(r"^(.*\d)([+-]\d\d)(\d\d)$", s)
    if m and ":" in m.group(1):
        s = f"{m.group(1)}{m.group(2)}:{m.group(3)}"
    # fromisoformat before 3.11 only takes 3 or 6 fractional digits
    m = re.match(r"^(.*:\d\d)\.(\d+)(.*)$", s)
    if m:
        s = f"{m.group(1)}.{(m.group(2) + '000000')[:6]}{m.group(3)}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt.astimezone(timezone.utc)


class Rec:
    __slots__ = ("d", "t", "t_from", "rx", "files", "vias")

    def __init__(self, d: dict, fname: str) -> None:
        self.d = d
        self.rx = parse_ts(d.get("rx"))
        ts = parse_ts(d.get("ts"))
        self.t = ts or self.rx
        self.t_from = "ts" if ts else ("rx" if self.rx else None)
        self.files = {fname}
        self.vias = {str(d["via"])} if d.get("via") else set()

    @property
    def kind(self) -> str:
        return str(self.d.get("kind", ""))

    def get(self, key, default=None):
        v = self.d.get(key, default)
        return default if v == "" else v

    def app(self, fields: list[str]) -> str | None:
        for f in fields:
            v = self.d.get(f)
            if v not in (None, ""):
                return str(v)
        return None

    def key(self) -> tuple:
        d = self.d
        stamp = d.get("ts") if d.get("ts") not in (None, "") else d.get("rx")
        return tuple(str(d.get(k, "")) for k in ("src", "kind", "app", "input", "cur", "run", "tick", "page", "seq", "note", "url")) + (str(stamp),)


def parse_line(line: str):
    """Parse one log line. Phone lines start with "tt " before the JSON (so
    Shortcuts treats them as text), and may have curly quotes from Smart
    Punctuation."""
    body = line[line.find("{"):] if "{" in line else line
    for candidate in (body, body.translate(CURLY_QUOTES)):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    return None


def load(paths: list[str]) -> tuple[list[Rec], dict[str, int]]:
    by_key: dict[tuple, Rec] = {}
    per_file: dict[str, int] = {}
    for path in paths:
        n = 0
        with open(path, encoding="utf-8-sig") as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                d = parse_line(line)
                if d is None:
                    print(f"warning: {path}:{lineno}: not JSON, skipped: {line[:80]}", file=sys.stderr)
                    continue
                if not isinstance(d, dict):
                    continue
                n += 1
                r = Rec(d, path)
                k = r.key()
                if k in by_key:
                    prev = by_key[k]
                    prev.files.add(path)
                    if d.get("via"):
                        prev.vias.add(str(d["via"]))
                    if prev.rx is None and r.rx is not None:
                        prev.rx = r.rx
                        prev.d["rx"] = d.get("rx")
                else:
                    by_key[k] = r
        per_file[path] = n
    recs = [r for r in by_key.values() if r.t is not None]
    dropped = len(by_key) - len(recs)
    if dropped:
        print(f"warning: {dropped} records had no parseable ts/rx and were ignored", file=sys.stderr)
    recs.sort(key=lambda r: r.t)
    return recs, per_file


# ---------------------------------------------------------------- helpers

def fmt_t(t: datetime | None, utc: bool) -> str:
    if t is None:
        return "?"
    return (t if utc else t.astimezone(LOCAL_TZ)).strftime("%H:%M:%S.%f")[:-3]


def fmt_d(seconds: float) -> str:
    seconds = float(seconds)
    sign = "-" if seconds < 0 else ""
    s = abs(seconds)
    if s < 60:
        return f"{sign}{s:.1f}s"
    if s < 3600:
        return f"{sign}{int(s // 60)}m{int(s % 60):02d}s"
    return f"{sign}{int(s // 3600)}h{int(s % 3600 // 60):02d}m"


def stats_line(values: list[float]) -> str:
    if not values:
        return "n=0"
    v = sorted(values)
    p90 = v[min(len(v) - 1, int(round(0.9 * (len(v) - 1))))]
    return f"n={len(v)}  min={fmt_d(v[0])}  median={fmt_d(statistics.median(v))}  p90={fmt_d(p90)}  max={fmt_d(v[-1])}"


def show(v) -> str:
    if v is None:
        return "<missing>"
    return str(v) if str(v).strip() else "<empty>"


def header(title: str) -> None:
    print(f"\n=== {title} " + "=" * max(0, 70 - len(title)))


def describe(r: Rec) -> str:
    skip = {"kind", "ts", "rx", "src", "peer", "path"}
    parts = [f"{k}={v}" for k, v in r.d.items() if k not in skip and v not in (None, "")]
    if r.d.get("cur") == "":
        parts.append("cur=<empty>")
    return " ".join(parts)


# ---------------------------------------------------------------- sections

def section_summary(recs, per_file, args):
    header("summary")
    if not recs:
        print("no records")
        return
    print(f"span: {fmt_t(recs[0].t, args.utc)} -> {fmt_t(recs[-1].t, args.utc)}  ({fmt_d((recs[-1].t - recs[0].t).total_seconds())})")
    for path, n in per_file.items():
        print(f"file {path}: {n} records")
    print(f"merged, de-duplicated: {len(recs)}")
    kinds = Counter(r.kind for r in recs)
    print("by kind: " + ", ".join(f"{k or '<none>'}={n}" for k, n in kinds.most_common()))
    no_ts = sum(1 for r in recs if r.t_from == "rx")
    if no_ts:
        print(f"{no_ts} records have no device ts (using receive time)")
    # "Only in X" matters when files cover the same events (receiver vs on-device log).
    if len(per_file) > 1 and any(len(r.files) > 1 for r in recs):
        for path in per_file:
            only = [r for r in recs if r.files == {path} and r.kind != "marker"]
            if only:
                ks = Counter(r.kind for r in only)
                print(f"only in {path}: {len(only)}  (" + ", ".join(f"{k}={n}" for k, n in ks.most_common()) + ")")


def section_timeline(recs, args):
    header("timeline")
    prev = None
    for r in recs:
        if r.kind == "marker":
            print(f"\n--- {fmt_t(r.t, args.utc)}  {r.get('note', '')} ---")
            prev = r.t
            continue
        delta = f"+{fmt_d((r.t - prev).total_seconds())}" if prev else ""
        print(f"{fmt_t(r.t, args.utc)} {delta:>9}  {r.kind:<20} {describe(r)}")
        prev = r.t


def section_sessions(recs, args):
    header("sessions (open/close pairing)")
    fields = args.app_field
    events = [r for r in recs if r.kind in ("open", "close")]
    polls = [r for r in recs if r.kind == "poll"]
    if not events:
        print("no open/close records")
        return

    open_since: dict[str, Rec] = {}
    sessions = []          # (start, end, app, how)
    unmatched = []         # (close rec, lower bound time or None)
    prev_evt_time = None
    for r in events:
        app = r.app(fields) or "<unknown>"
        if r.kind == "close" and args.anon_close:
            # Close events don't reliably name the app: a close ends whatever is open.
            # If two apps look open (the next open arrived before this close), the older one is closing.
            app = next(iter(open_since), None) or "<unknown>"
            if app == "<unknown>":
                window = [p for p in polls if (prev_evt_time is None or p.t > prev_evt_time) and p.t <= r.t]
                seen = Counter(v for v in (p.d.get("cur") for p in window) if v and str(v).strip())
                app = seen.most_common(1)[0][0] if seen else "<unknown>"
        if r.kind == "open":
            if app in open_since:
                print(f"note: {fmt_t(r.t, args.utc)} second open of {app} without a close in between")
            open_since[app] = r
        else:
            if app in open_since:
                start = open_since.pop(app)
                sessions.append((start.t, r.t, app, "exact"))
            else:
                unmatched.append((r, app, prev_evt_time))
        prev_evt_time = r.t

    print(f"exact sessions: {len(sessions)}")
    if unmatched:
        print(f"\ncloses with no matching open: {len(unmatched)}  (you were already in the app, e.g. unlocked straight into it)")
    for r, app, lower in unmatched:
        window = [p for p in polls if (lower is None or p.t > lower) and p.t <= r.t]
        first = next((p for p in window if (p.app(["cur", "app"]) or "") == app), None)
        low_s = fmt_t(lower, args.utc) if lower else "start of log"
        line = f"  {fmt_t(r.t, args.utc)} close {app}: resumed somewhere in ({low_s}, {fmt_t(r.t, args.utc)}]"
        if first:
            before = [p for p in window if p.t < first.t]
            bound = f"{fmt_t(before[-1].t, args.utc)} said {show(before[-1].d.get('cur'))}" if before else "no earlier poll in window"
            line += f"\n      polling: first saw {app} at {fmt_t(first.t, args.utc)} ({bound}) -> estimated start {fmt_t(first.t, args.utc)}"
            sessions.append((first.t, r.t, app, "poll-bounded"))
        elif lower is not None:
            line += "\n      no poll samples of this app in the window -> unresolved"
            sessions.append((lower, r.t, app, "upper-bound"))
        print(line)

    if open_since:
        print(f"\nopens that never closed (still open, phone died, or log ends): {len(open_since)}")
        for app, r in open_since.items():
            print(f"  {fmt_t(r.t, args.utc)} open {app}")

    # Time with no app open: gaps between the (exact + reconstructed) sessions.
    merged = []
    for start, end, _, _ in sorted(sessions):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    gaps = [(a[1], b[0], (b[0] - a[1]).total_seconds()) for a, b in zip(merged, merged[1:])]
    long_gaps = [g for g in gaps if g[2] >= args.gap]
    print(f"\ngaps between sessions: {stats_line([g[2] for g in gaps])}")
    if long_gaps:
        print(f"gaps >= {fmt_d(args.gap)} with no app open (lock, Home Screen, or untracked app): {len(long_gaps)}, total {fmt_d(sum(g[2] for g in long_gaps))}")
        for a, b, secs in sorted(long_gaps)[:20]:
            inside = Counter(show(p.d.get("cur")) for p in polls if a < p.t < b)
            seen = ", ".join(f"{k} x{n}" for k, n in inside.most_common(4)) or "no polls"
            print(f"  {fmt_t(a, args.utc)} -> {fmt_t(b, args.utc)}  {fmt_d(secs):>8}   polls: {seen}")

    totals = defaultdict(float)
    for start, end, app, how in sessions:
        totals[(app, how)] += (end - start).total_seconds()
    print("\ntime per app (exact + reconstructed):")
    for app in sorted({a for a, _ in totals}, key=lambda a: -sum(v for (x, _), v in totals.items() if x == a)):
        parts = {how: v for (a, how), v in totals.items() if a == app}
        detail = "  ".join(f"{how}={fmt_d(v)}" for how, v in parts.items())
        print(f"  {app:<28} {fmt_d(sum(parts.values())):>8}   {detail}")


def section_closecur(recs, args):
    header("close events: what did Get Current App report?")
    events = [r for r in recs if r.kind in ("open", "close")]
    counts = Counter()
    for i, r in enumerate(events):
        if r.kind != "close" or "cur" not in r.d:
            continue
        cur = r.d.get("cur")
        prev_open = next((e for e in reversed(events[:i]) if e.kind == "open"), None)
        next_open = next((e for e in events[i + 1:] if e.kind == "open" and (e.t - r.t).total_seconds() <= 5), None)
        closing = r.app(["app", "input"]) or (prev_open.app(["app", "input", "cur"]) if prev_open else None)
        if cur in (None, "") or not str(cur).strip():
            counts["empty"] += 1
        elif closing and str(cur) == closing:
            counts["closing app"] += 1
        elif next_open and str(cur) == next_open.app(["app", "input", "cur"]):
            counts["next app"] += 1
        else:
            counts["something else"] += 1
    if not counts:
        print("no close events with a 'cur' field")
        return
    total = sum(counts.values())
    print(f"of {total} closes, cur was: " + "   ".join(f"{k}={counts[k]}" for k in ("closing app", "next app", "empty", "something else")))
    inputs = sum(1 for r in events if r.get("input"))
    print(f"open/close events carrying Shortcut Input: {inputs} of {len(events)}")


def section_runs(recs, args):
    header("runs (polling loops, Safari background ticks)")
    runs = defaultdict(list)
    for r in recs:
        if r.get("run") is not None and r.kind in ("poll", "poll.end", "probe", "safari.bg.tick", "safari.bg.start", "safari.bg.alarm"):
            family = "safari-bg" if r.kind.startswith("safari") else "poll"
            runs[(family, str(r.get("run")))].append(r)
    if not runs:
        print("no records with a run id")
        return
    print(f"{'run':<18} {'ctx':<18} {'start':>12} {'last':>12} {'lifetime':>9} {'ticks':>6} {'median':>8} {'max gap':>8} {'>2x':>4}  ended")
    for (family, run), rs in sorted(runs.items(), key=lambda kv: kv[1][0].t):
        rs.sort(key=lambda r: r.t)
        diffs = [(b.t - a.t).total_seconds() for a, b in zip(rs, rs[1:])]
        med = statistics.median(diffs) if diffs else 0
        big = sum(1 for d in diffs if med and d > 2 * med)
        ended = "yes" if any(r.kind == "poll.end" for r in rs) else "no (killed?)" if family == "poll" else "-"
        ctx = next((str(r.get("ctx")) for r in rs if r.get("ctx")), "")
        life = (rs[-1].t - rs[0].t).total_seconds()
        print(f"{family + ':' + run:<18} {ctx[:18]:<18} {fmt_t(rs[0].t, args.utc):>12} {fmt_t(rs[-1].t, args.utc):>12} "
              f"{fmt_d(life):>9} {len(rs):>6} {fmt_d(med):>8} {fmt_d(max(diffs) if diffs else 0):>8} {big:>4}  {ended}")


def section_apps(recs, args):
    header("values returned by Get Current App")
    for kinds, label in ((("poll",), "polls"), (("open",), "on open"), (("close",), "on close")):
        c = Counter(show(r.d.get("cur")) for r in recs if r.kind in kinds)
        if not c:
            continue
        print(f"{label}:")
        for v, n in c.most_common():
            print(f"  {n:>5}  {v}")
    probes = Counter(str(r.get("probe")) for r in recs if r.get("probe"))
    if probes:
        print("lock probe results: " + ", ".join(f"{k} x{n}" for k, n in probes.most_common()))
    bundles = Counter(str(r.get("bundle")) for r in recs if r.get("bundle"))
    if bundles:
        print("bundle ids seen: " + ", ".join(bundles))


def section_latency(recs, args):
    header("latency (receive time - device timestamp)")
    by_kind = defaultdict(list)
    for r in recs:
        if r.t_from == "ts" and r.rx is not None:
            by_kind[r.kind].append((r.rx - r.t).total_seconds())
    if not by_kind:
        print("no records with both ts and rx")
        return
    for kind, vals in sorted(by_kind.items()):
        late = sum(1 for v in vals if v > 10)
        neg = sum(1 for v in vals if v < -1)
        extra = (f"  delivered >10s late: {late}" if late else "") + (f"  negative (clock skew?): {neg}" if neg else "")
        print(f"{kind:<22} {stats_line(vals)}{extra}")


def section_safari(recs, args):
    header("safari probe")
    rs = [r for r in recs if r.kind.startswith("safari.")]
    if not rs:
        print("no safari records")
        return
    for k, n in Counter(r.kind for r in rs).most_common():
        print(f"  {n:>5}  {k}")
    pages = defaultdict(list)
    for r in rs:
        if r.get("page") is not None and r.get("seq") is not None:
            try:
                pages[str(r.get("page"))].append(int(r.get("seq")))
            except (TypeError, ValueError):
                pass
    missing = 0
    for seqs in pages.values():
        s = sorted(set(seqs))
        missing += (s[-1] - s[0] + 1) - len(s)
    if pages:
        print(f"content-script pages: {len(pages)}  records missing by sequence number (dropped messages): {missing}")
    vias = Counter("+".join(sorted(r.vias)) for r in rs if r.vias)
    if vias:
        print("content-script records arrived via: " + ", ".join(f"{k}={n}" for k, n in vias.most_common()))
    urls = [r for r in rs if r.kind in ("safari.cs.url", "safari.tabs.updated")]
    if urls:
        print(f"URL-change signals: content script={sum(1 for r in urls if r.kind == 'safari.cs.url')}  "
              f"tabs.onUpdated={sum(1 for r in urls if r.kind == 'safari.tabs.updated')}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--section", action="append", choices=SECTIONS, help="only print these sections (repeatable)")
    ap.add_argument("--since", help="ISO time; local time if no offset")
    ap.add_argument("--until", help="ISO time; local time if no offset")
    ap.add_argument("--utc", action="store_true", help="print times in UTC instead of local time")
    ap.add_argument("--gap", type=float, default=30, help="report no-app gaps at least this long, seconds (default 30)")
    ap.add_argument("--app-field", action="append", help="fields that identify the app on open/close, in order (default: app, input, cur)")
    ap.add_argument("--anon-close", action="store_true",
                    help="ignore the app named on close events; a close ends whatever app is open (use if T2 shows close events report the wrong app)")
    args = ap.parse_args()
    args.app_field = args.app_field or ["app", "input", "cur"]

    recs, per_file = load(args.files)
    since, until = parse_ts(args.since), parse_ts(args.until)
    for flag, raw, parsed in (("--since", args.since, since), ("--until", args.until, until)):
        if raw and parsed is None:
            ap.error(f"{flag} {raw!r}: use an ISO time like 2026-09-25T14:00")
    if since:
        recs = [r for r in recs if r.t >= since]
    if until:
        recs = [r for r in recs if r.t <= until]

    for s in args.section or SECTIONS:
        if s == "summary":
            section_summary(recs, per_file, args)
        else:
            globals()[f"section_{s}"](recs, args)
    print()


if __name__ == "__main__":
    main()
