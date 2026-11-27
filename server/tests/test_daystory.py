"""daystory.py: what the day's story is written from, when it's due, and storing it."""

import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ttserver import daystory  # noqa: E402
from ttserver.labels import Labeler, Provider  # noqa: E402
from ttserver.store import Store  # noqa: E402
from test_activity import NOW, T0, FakeAW  # noqa: E402


def line(minute, kind, **kv):
    ts = (T0 + timedelta(minutes=minute)).isoformat()
    return "|".join(["tt", "src=ios", f"kind={kind}", "dev=Phone", f"ts={ts}"] + [f"{k}={v}" for k, v in kv.items()])


class DayStory(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(f"{self.dir.name}/tt.db")
        self.store.add_lines([
            line(0, "visit", arrive=(T0 - timedelta(hours=2)).isoformat(), depart=(T0 + timedelta(minutes=30)).isoformat(),
                 lat="34.02000", lon="-118.28000", acc="20"),
            line(30, "motion", activity="walking", conf="high"),
            line(45, "motion", activity="stationary", conf="high"),
            line(50, "visit", arrive=(T0 + timedelta(minutes=45)).isoformat(), depart="-",
                 lat="34.07000", lon="-118.44000", acc="20"),
            line(40, "change", run="1", locked="No", cur="Instagram"),
            line(60, "change", run="1", locked="Yes", cur="Instagram"),
        ], "ios", "Phone")
        self.asked = []

        def call(p, system, user):
            self.asked.append((p.model, system, json.loads(user)))
            if system == daystory.SYSTEM:
                return "**A day of code and one long scroll**\n\n### How it went\nMorning: code."
            ids = json.loads(user)
            return json.dumps({b: {"project": "TimeTracker", "label": "Watcher", "kind": "building",
                                   "verdict": "productive", "summary": "Built it."} for b in ids})

        self.labeler = Labeler(f"{self.dir.name}/labels.db", chain=[Provider("anthropic", "http://x", "claude-haiku-5-5", "k")],
                               call=call)
        self.relay = SimpleNamespace(aw=FakeAW(), store=self.store)

    def tearDown(self):
        self.dir.cleanup()

    def range(self):
        return T0 - timedelta(hours=6), T0 + timedelta(hours=3)

    def test_gather_has_no_coordinates(self):
        got = daystory.gather(self.relay, None, self.labeler, "2026-11-01", *self.range(), now=NOW)
        self.assertEqual(got["day"], "2026-11-01")
        self.assertEqual([p["place"] for p in got["places"]], ["A", "B"])
        self.assertEqual(got["places"][1]["depart"], "still there")
        self.assertNotIn("34.0", json.dumps(got))
        self.assertEqual(got["movement"]["minutes"]["walking"], 15)
        self.assertEqual(got["phone_locks"]["longest_unlocked"][0]["min"], 20)
        self.assertTrue(got["stretches"])
        self.assertGreater(got["totals"]["screen_min"], 0)

    def test_write_and_read(self):
        out = daystory.write(self.relay, None, self.labeler, "end", "2026-11-01", *self.range(), now=NOW)
        self.assertTrue(out["text"].startswith("**A day"))
        model = [m for m, system, _ in self.asked if system == daystory.SYSTEM][0]
        self.assertEqual(model, daystory.STORY_MODEL)
        got = daystory.stories(self.store, "2026-11-01")
        self.assertEqual([(s["slot"], s["model"]) for s in got], [("end", "anthropic/" + daystory.STORY_MODEL)])

    def test_due_follows_the_day(self):
        # Activity 10:00-11:30 PST on 2026-11-01 (T0 is 10:00 PST). Midday comes 6 h after the first
        # activity. A quiet evening doesn't end the day; 4 quiet hours reaching into 2-8 AM do.
        at = lambda h, m=0: T0 + timedelta(hours=h - 10, minutes=m)  # noqa: E731  (local PST hour)
        self.assertIsNone(daystory.due(self.relay, at(15, 59)))
        self.assertEqual(daystory.due(self.relay, at(16, 1))[:2], ("2026-11-01", "midday"))
        self.assertEqual(daystory.due(self.relay, at(23, 59))[:2], ("2026-11-01", "midday"))
        day, slot, start, end = daystory.due(self.relay, at(26, 1))  # 2:01 AM
        self.assertEqual((day, slot), ("2026-11-01", "end"))
        self.assertEqual(end, T0 + timedelta(minutes=90))  # the last activity
        daystory.write(self.relay, None, self.labeler, slot, day, start, end, now=at(26, 1))
        self.assertIsNone(daystory.due(self.relay, at(26, 1)))

    def add_laptop(self, from_h, hours):
        t = (T0 + timedelta(hours=from_h - 10)).isoformat()
        self.relay.aw.store["aw-watcher-window_laptop"].append(
            {"timestamp": t, "duration": hours * 3600, "data": {"app": "Code.exe", "title": "x"}})
        self.relay.aw.store["aw-watcher-afk_laptop"].append(
            {"timestamp": t, "duration": hours * 3600, "data": {"status": "not-afk"}})

    def test_evening_away_then_a_night_session(self):
        # Off every screen 11:30-22:54 (dinner), back on until 23:48: the night session is part of the day.
        self.add_laptop(23, 0.75)
        now = T0 + timedelta(hours=14)  # 00:00
        self.assertIsNone(daystory.bounds(self.relay, "2026-11-01", now)["ended"])
        now = T0 + timedelta(hours=18)  # 4:00, quiet since 23:45
        self.assertEqual(daystory.bounds(self.relay, "2026-11-01", now)["ended"], T0 + timedelta(hours=13, minutes=45))

    def test_late_night_belongs_to_the_day(self):
        # On the laptop from 18:00 until 5:00 the next morning: the day ends there, not at 4 AM.
        self.add_laptop(18, 11)
        now = T0 + timedelta(hours=23, minutes=30)  # 9:30 PST on 11-02
        b = daystory.bounds(self.relay, "2026-11-01", now)
        self.assertEqual(b["ended"], T0 + timedelta(hours=19))  # 5:00 PST
        day, slot, start, end = daystory.due(self.relay, now)
        self.assertEqual((day, slot, end), ("2026-11-01", "end", T0 + timedelta(hours=19)))
        daystory.write(self.relay, None, self.labeler, slot, day, start, end, now=now)
        self.assertEqual(daystory.bounds(self.relay, "2026-11-02", now)["start"], T0 + timedelta(hours=19))

    def test_whoop_sleep_ends_the_day(self):
        # WHOOP says asleep at 0:30 after a session until 0:20: ended at 0:20, even with no long quiet yet.
        self.add_laptop(23, 1 + 1 / 3)
        sleep = {"kind": "sleep", "nap": False, "start": (T0 + timedelta(hours=14, minutes=30)).isoformat(),
                 "end": (T0 + timedelta(hours=22)).isoformat()}
        whoop = SimpleNamespace(records=lambda kind, since: [sleep] if kind == "sleep" else [])
        now = T0 + timedelta(hours=22, minutes=10)
        b = daystory.bounds(self.relay, "2026-11-01", now, whoop=whoop)
        self.assertEqual(b["ended"], T0 + timedelta(hours=14, minutes=20))


if __name__ == "__main__":
    unittest.main()
