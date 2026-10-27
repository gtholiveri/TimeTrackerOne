"""The desktop mirror against a stand-in for aw-server-rust's REST API, which
cuts the events it lists to the query range the way the real server does."""

import sys
import unittest
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver import awsync  # noqa: E402
from ttserver.mirror import mirror_once  # noqa: E402

UTC = timezone.utc
T0 = datetime(2026, 10, 21, 9, 0, 0, tzinfo=UTC)


class FakeAW(awsync.AW):
    """Buckets in memory behind AW's own request code."""

    def __init__(self):
        super().__init__("http://fake")
        self.store: dict[str, dict] = {}
        self.next_id = 1

    def _req(self, method, path, body=None):
        url = urllib.parse.urlsplit(path)
        parts = [urllib.parse.unquote(p) for p in url.path.strip("/").split("/")]
        if parts == ["buckets"]:
            return {b: v["meta"] for b, v in self.store.items()}
        bucket = parts[1]
        if len(parts) == 2:
            self.store.setdefault(bucket, {"meta": {"id": bucket, **body}, "events": {}})
            return None
        events = self.store[bucket]["events"]
        if len(parts) == 4:
            if method == "DELETE":
                del events[int(parts[3])]
                return None
            return dict(events[int(parts[3])])
        if method == "POST":
            for e in body:
                events[self.next_id] = {"id": self.next_id, **e}
                self.next_id += 1
            return None
        q = urllib.parse.parse_qs(url.query)
        lo = awsync.parse_aw_ts(q["start"][0]).timestamp()
        hi = awsync.parse_aw_ts(q["end"][0]).timestamp()
        out = []
        for e in events.values():
            start = awsync.parse_aw_ts(e["timestamp"]).timestamp()
            end = start + e["duration"]
            if end < lo or start > hi:
                continue
            start, end = max(start, lo), min(end, hi)  # what aw-server-rust does
            out.append({**e, "timestamp": datetime.fromtimestamp(start, UTC).isoformat(), "duration": end - start})
        return out

    def whole(self, bucket):
        return sorted((awsync.parse_aw_ts(e["timestamp"]), e["duration"], e["data"]["status"])
                      for e in self.store[bucket]["events"].values())


class Mirror(unittest.TestCase):
    def test_long_span_survives_passes_that_start_inside_it(self):
        bucket = "aw-watcher-afk_DESKTOP-TEST"
        local, remote = FakeAW(), FakeAW()
        local.ensure_bucket(bucket, "afkstatus", "DESKTOP-TEST", client="aw-watcher-afk")
        local.insert(bucket, [awsync.event(T0, T0 + timedelta(minutes=10), {"status": "not-afk"})])
        state = {}
        now = T0 + timedelta(minutes=10)
        mirror_once(local, remote, state, timedelta(days=1), now)

        # Four hours of work: the watcher keeps extending the same not-afk
        # event while each pass only looks at the last two hours.
        for minute in range(11, 4 * 60):
            now = T0 + timedelta(minutes=minute)
            event = next(iter(local.store[bucket]["events"].values()))
            event["duration"] = (now - T0).total_seconds()
            mirror_once(local, remote, state, timedelta(days=1), now)

        self.assertEqual(remote.whole(bucket), [(T0, (now - T0).total_seconds(), "not-afk")])
        self.assertEqual(mirror_once(local, remote, state, timedelta(days=1), now)[bucket], (0, 0))

    def test_repairs_a_copy_cut_short_earlier(self):
        bucket = "aw-watcher-afk_DESKTOP-TEST"
        local, remote = FakeAW(), FakeAW()
        for aw in (local, remote):
            aw.ensure_bucket(bucket, "afkstatus", "DESKTOP-TEST", client="aw-watcher-afk")
        local.insert(bucket, [awsync.event(T0, T0 + timedelta(hours=5), {"status": "not-afk"})])
        remote.insert(bucket, [awsync.event(T0 + timedelta(hours=3), T0 + timedelta(hours=5), {"status": "not-afk"})])
        now = T0 + timedelta(hours=5)
        mirror_once(local, remote, {}, timedelta(days=1), now)  # a fresh state copies the whole backfill
        self.assertEqual(remote.whole(bucket), [(T0, 5 * 3600.0, "not-afk")])


if __name__ == "__main__":
    unittest.main()
