"""coverage.py: per-day counts and TT Watch runs."""

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver.coverage import coverage  # noqa: E402
from ttserver.store import Store  # noqa: E402

NOW = datetime(2030, 3, 4, 20, 0, tzinfo=timezone.utc)


def line(ts, kind, **kw):
    extra = "".join(f"|{k}={v}" for k, v in kw.items())
    return f"tt|src=ios|kind={kind}|dev=Test Phone|ts={ts}{extra}"


class Coverage(unittest.TestCase):
    def test_days_kinds_and_runs(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(f"{d}/tt.db")
            store.add_lines([
                line("2030-03-03 23:30:00.000-08:00", "start", run="11"),
                line("2030-03-04 00:10:00.000-08:00", "change", run="11", locked="No", cur="Mail"),
                line("2030-03-04 06:00:00.000-08:00", "beat", run="11"),
                line("2030-03-04 07:00:00.000-08:00", "open", cur="Mail"),
                line("2030-03-04 07:01:00.000-08:00", "loc", lat="1", lon="2"),
                line("2030-03-04 07:02:00.000-08:00", "end", run="11"),
                line("2030-03-04 08:00:00.000-08:00", "start", run="22"),
            ], "ios")
            store.add_lines(['{"ts": "2030-03-04T16:00:00Z", "url": "https://example.com"}'], "safari", "Test Phone")
            out = coverage(store, days=7, tz="America/Los_Angeles", now=NOW)
        days = {x["day"]: x for x in out["days"]}
        self.assertEqual(days["2030-03-03"]["ios"], {"start": 1})
        self.assertEqual(days["2030-03-04"]["ios"], {"beat": 1, "change": 1, "end": 1, "loc": 1, "open": 1, "start": 1})
        self.assertEqual(days["2030-03-04"]["safari"], 1)
        self.assertEqual(days["2030-03-04"]["devices"], ["Test Phone"])
        runs = {r["run"]: r for r in out["watch_runs"]}
        self.assertEqual(runs["11"]["lines"], 4)
        self.assertTrue(runs["11"]["ended"])
        self.assertAlmostEqual(runs["11"]["hours"], 7.53, places=2)
        self.assertFalse(runs["22"]["ended"])


if __name__ == "__main__":
    unittest.main()
