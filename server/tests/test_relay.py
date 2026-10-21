"""Line parsing, the TT Sync upload protocol, Safari pages, and AW event shapes."""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver.app import Relay, ingest, ingest_safari  # noqa: E402
from ttserver.awsync import device_events, hostname  # noqa: E402
from ttserver.fusion import Interval  # noqa: E402
from ttserver.lines import parse_line, parse_ts, to_record  # noqa: E402
from ttserver.store import Store  # noqa: E402
from ttserver.web import split_safari, web_segments  # noqa: E402

UTC = timezone.utc
T0 = datetime(2026, 10, 21, 17, 0, 0, tzinfo=UTC)
DEV = "Gabe’s iPhone"


def line(s, kind, **kv):
    ts = (T0 + timedelta(seconds=s)).astimezone(timezone(timedelta(hours=-7)))
    fields = {"src": "ios", "kind": kind, "dev": DEV, "ts": ts.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + "-07:00", **kv}
    return "tt|" + "|".join(f"{k}={v}" for k, v in fields.items())


class Lines(unittest.TestCase):
    def test_kv_line(self):
        d = parse_line("tt|src=ios|kind=open|dev=Gabe's iPhone|ts=2026-10-21 10:00:01.250-07:00|input=Safari|cur=Safari")
        self.assertEqual(d["dev"], "Gabe's iPhone")
        r = to_record(d)
        self.assertEqual(r.ts, datetime(2026, 10, 21, 17, 0, 1, 250000, tzinfo=UTC))
        self.assertEqual(r.app_identity, "Safari")

    def test_pipe_inside_a_value(self):
        self.assertEqual(parse_line("tt|kind=open|input=A|B|cur=A|B")["input"], "A|B")

    def test_json_line_with_curly_quotes(self):
        self.assertEqual(parse_line('{“kind”: “open”}'), {"kind": "open"})

    def test_timestamps(self):
        self.assertEqual(parse_ts("2026-10-21T17:00:00.000Z"), T0)
        self.assertIsNone(parse_ts("yesterday"))

    def test_hostname(self):
        self.assertEqual(hostname(DEV), "Gabe-s-iPhone")


class SyncProtocol(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.relay = Relay(Store(str(Path(self.tmp.name) / "tt.db")), None)

    def tearDown(self):
        self.tmp.cleanup()

    def post(self, lines, total, mode="tail"):
        q = {"file": "tt-watch-2026-10-21.txt", "lines": str(total), "mode": mode, "dev": DEV}
        return ingest(self.relay, q, "\n".join(lines))

    def test_tail_then_full_then_tail(self):
        all_lines = [line(i * 10, "change", tick=i, locked="No", cur="Safari") for i in range(50)]
        self.assertEqual(self.post(all_lines[-20:], 50), "full")       # first contact: missing 30
        self.assertEqual(self.post(all_lines, 50, "full"), "ok")
        more = all_lines + [line(600 + i, "change", tick=60 + i, locked="No", cur="Mail") for i in range(5)]
        self.assertEqual(self.post(more[-20:], 55), "ok")               # the tail covers the 5 new lines
        gap = more + [line(900 + i, "beat", tick=90 + i, locked="Yes", cur="Mail") for i in range(30)]
        self.assertEqual(self.post(gap[-20:], 85), "full")              # 10 lines never arrived
        self.assertEqual(self.post(gap, 85, "full"), "ok")
        self.assertEqual(len(self.relay.store.lines("ios", T0 - timedelta(days=1))), 85)

    def test_short_file_sent_whole_in_tail_mode(self):
        lines = [line(0, "open", input="Safari", cur="Safari")]
        self.assertEqual(self.post(lines, 1), "ok")

    def test_duplicates_ignored_and_device_marked_dirty(self):
        lines = [line(0, "open", input="Safari", cur="Safari"), line(5, "close", input="Safari", cur="Safari")]
        ingest(self.relay, {}, "\n".join(lines))
        ingest(self.relay, {}, "\n".join(lines))
        self.assertEqual(len(self.relay.store.lines("ios", T0 - timedelta(days=1))), 2)
        self.assertEqual(self.relay.dirty[DEV], T0)

    def test_safari_records(self):
        ingest(self.relay, {}, line(0, "open", input="Safari", cur="Safari"))
        recs = [{"src": "safari", "kind": "show", "page": "p1", "seq": 0, "url": "https://a.example/",
                 "title": "A", "vis": "visible", "ts": "2026-10-21T17:00:01Z"}]
        self.assertEqual(ingest_safari(self.relay, {}, json.dumps(recs))["new"], 1)
        self.assertEqual(ingest_safari(self.relay, {}, json.dumps(recs))["new"], 0)


class SafariPages(unittest.TestCase):
    def rec(self, s, kind, page="p1", url="https://a.example/", title="A", vis="visible"):
        return {"kind": kind, "page": page, "url": url, "title": title, "vis": vis,
                "ts": (T0 + timedelta(seconds=s)).isoformat()}

    def test_segments(self):
        recs = [self.rec(0, "show"), self.rec(15, "beat"), self.rec(20, "nav", url="https://b.example/", title="B"),
                self.rec(35, "beat", url="https://b.example/", title="B"),
                self.rec(40, "hide", url="https://b.example/", title="B", vis="hidden"),
                self.rec(100, "show", page="p2", url="https://c.example/", title="C")]
        pages = web_segments(recs, T0 + timedelta(seconds=300))
        got = [((p.start - T0).total_seconds(), (p.end - T0).total_seconds(), p.title) for p in pages]
        self.assertEqual(got, [(0, 20, "A"), (20, 40, "B"), (100, 140, "C")])  # C: beats stopped

    def test_clipped_to_safari_in_front(self):
        recs = [self.rec(0, "show"), self.rec(15, "beat"), self.rec(30, "beat"), self.rec(45, "beat")]
        pages = web_segments(recs, T0 + timedelta(seconds=60))
        ivs = [Interval(T0 - timedelta(seconds=10), T0 + timedelta(seconds=25), "app", "Safari"),
               Interval(T0 + timedelta(seconds=25), T0 + timedelta(seconds=60), "app", "Mail")]
        parts = [((iv.start - T0).total_seconds(), (iv.end - T0).total_seconds(), iv.app, p.title if p else None)
                 for iv, p in split_safari(ivs, pages)]
        self.assertEqual(parts, [(-10, 0, "Safari", None), (0, 25, "Safari", "A"), (25, 60, "Mail", None)])


class AWEvents(unittest.TestCase):
    def test_buckets(self):
        s = lambda x: T0 + timedelta(seconds=x)  # noqa: E731
        ivs = [Interval(s(0), s(10), "app", "Mail", "exact"), Interval(s(10), s(20), "home", None, "tick"),
               Interval(s(20), s(80), "locked", None, "inferred")]
        ev = device_events(ivs, [])
        self.assertEqual([e["data"]["app"] for e in ev["window"]], ["Mail", "Home Screen"])
        self.assertEqual([(e["data"]["status"], e["duration"]) for e in ev["afk"]],
                         [("not-afk", 20.0), ("afk", 60.0)])
        self.assertEqual(ev["web"], [])


if __name__ == "__main__":
    unittest.main()
