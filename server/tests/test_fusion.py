"""Fusion on synthetic scenarios. Times are seconds after T0."""

import random
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver.fusion import LOCK_INFER, Record, fuse  # noqa: E402

T0 = datetime(2026, 10, 21, 10, 0, 0, tzinfo=timezone(timedelta(hours=-7)))


def t(s):
    return T0 + timedelta(seconds=s)


def w(s, locked, cur="", kind="change"):
    return Record(t(s), kind, locked=locked, cur=cur, run="1")


def opened(s, app):
    return Record(t(s), "open", input=app, cur=app)


def closed(s, app):
    return Record(t(s), "close", input=app, cur=app)


def phone_close(s, cur):
    """A close as the phone really sends it: no input, and Get Current App says
    what's in front once the shortcut runs (after a swipe, the next app)."""
    return Record(t(s), "close", input="", cur=cur)


def simple(intervals):
    """(start s, end s, what) with what = app name, "home" or "locked"."""
    return [(round((i.start - T0).total_seconds(), 1), round((i.end - T0).total_seconds(), 1),
             i.app if i.state == "app" else i.state) for i in intervals]


class WatcherOnly(unittest.TestCase):
    def test_states_and_open_tail(self):
        recs = [Record(t(0), "start", run="1"),
                w(2.3, "No", "Safari"), w(60, "No", ""), w(90, "Yes", "Mail"), w(300, "No", "Mail")]
        out = fuse(recs, t(400))
        self.assertEqual(simple(out), [(2.3, 60, "Safari"), (60, 90, "home"), (90, 300, "locked"),
                                       (300, 400, "Mail")])
        self.assertEqual(out[-1].confidence, "provisional")
        self.assertEqual(out[0].confidence, "tick")

    def test_beats_dont_split(self):
        recs = [w(0, "No", "Safari"), w(345, "No", "Safari", "beat"), w(690, "No", "Safari", "beat")]
        self.assertEqual(simple(fuse(recs, t(700))), [(0, 700, "Safari")])

    def test_end_line_closes_state(self):
        recs = [w(0, "No", "Safari"), Record(t(100), "end", run="1")]
        self.assertEqual(simple(fuse(recs, t(5000))), [(0, 100, "Safari")])


class Snapping(unittest.TestCase):
    def test_transitions_move_to_automation_events(self):
        recs = [opened(1.0, "Safari"), w(2.3, "No", "Safari"),
                closed(58.5, "Safari"), opened(58.6, "Mail"), w(60, "No", "Mail"),
                closed(88.9, "Mail"), w(90, "Yes", "Mail"),
                w(300, "No", "Mail")]
        out = fuse(recs, t(310))
        self.assertEqual(simple(out), [(1.0, 58.6, "Safari"), (58.6, 88.9, "Mail"),
                                       (88.9, 300, "locked"), (300, 310, "Mail")])
        self.assertEqual(out[1].confidence, "exact")
        self.assertEqual(out[2].confidence, "exact")

    def test_unlock_into_same_app(self):
        # Locking fires a close; unlocking back into Reddit fires nothing.
        recs = [opened(0, "Reddit"), w(1.5, "No", "Reddit"),
                closed(100, "Reddit"), w(101, "Yes", "Reddit"),
                w(400, "No", "Reddit")]
        out = fuse(recs, t(500))
        self.assertEqual(simple(out), [(0, 100, "Reddit"), (100, 400, "locked"), (400, 500, "Reddit")])

    def test_swipe_close_is_the_switch(self):
        # Swiping from Files to Maps fires a close and no open; by then Get
        # Current App already says Maps. Then locking fires a close as usual.
        recs = [opened(0, "Files"), w(1.2, "No", "Files"),
                phone_close(100.0, "Google Maps"), w(101.2, "No", "Google Maps"),
                phone_close(150.0, "Google Maps"), w(151.0, "Yes", "Google Maps"),
                w(300, "No", "Google Maps")]
        out = fuse(recs, t(310))
        self.assertEqual(simple(out), [(0, 100.0, "Files"), (100.0, 150.0, "Google Maps"),
                                       (150.0, 300, "locked"), (300, 310, "Google Maps")])
        self.assertEqual(out[1].confidence, "exact")

    def test_swipes_back_and_forth(self):
        recs = [opened(0, "Files"), w(1.5, "No", "Files"),
                phone_close(60.0, "Gemini"), w(61.4, "No", "Gemini"),
                phone_close(63.3, "Files"), w(64.0, "No", "Files")]
        self.assertEqual(simple(fuse(recs, t(90))), [(0, 60.0, "Files"), (60.0, 63.3, "Gemini"),
                                                     (63.3, 90, "Files")])

    def test_close_to_home_is_not_a_swipe(self):
        recs = [opened(0, "Files"), w(1.5, "No", "Files"),
                phone_close(60.0, ""), w(61.4, "No", ""), opened(70.0, "Mail"), w(71.0, "No", "Mail")]
        self.assertEqual(simple(fuse(recs, t(90))), [(0, 60.0, "Files"), (60.0, 70.0, "home"),
                                                     (70.0, 90, "Mail")])


class LiveTail(unittest.TestCase):
    def test_open_ahead_of_the_watcher(self):
        # The open synced before the watcher logged it.
        recs = [w(0, "No", "Safari"), opened(200, "Mail")]
        out = fuse(recs, t(230))
        self.assertEqual(simple(out), [(0, 200, "Safari"), (200, 230, "Mail")])
        self.assertEqual(out[-1].confidence, "provisional")

    def test_watcher_line_replaces_the_guess(self):
        recs = [w(0, "No", "Safari"), opened(200, "Mail"), w(201.5, "No", "Mail")]
        self.assertEqual(simple(fuse(recs, t(230))), [(0, 200, "Safari"), (200, 230, "Mail")])

    def test_trailing_close_is_home_then_locked(self):
        recs = [w(0, "No", "Safari"), closed(100, "Safari")]
        soon = fuse(recs, t(100 + LOCK_INFER - 1))
        self.assertEqual(simple(soon)[-1][2], "home")
        later = fuse(recs, t(160))
        self.assertEqual(simple(later), [(0, 100, "Safari"), (100, 160, "locked")])
        self.assertEqual(later[-1].confidence, "provisional")

    def test_provisional_is_capped(self):
        recs = [w(0, "No", "Safari")]
        out = fuse(recs, t(10 * 3600))
        self.assertEqual(simple(out), [(0, 3 * 3600, "Safari")])


class AutomationsOnly(unittest.TestCase):
    def test_home_and_locked_inferred_from_gaps(self):
        recs = [opened(0, "Notes"), closed(100, "Notes"), opened(110, "Safari"),
                closed(200, "Safari"), opened(1000, "Mail")]
        out = fuse(recs, t(1100))
        self.assertEqual(simple(out), [(0, 100, "Notes"), (100, 110, "home"), (110, 200, "Safari"),
                                       (200, 1000, "locked"), (1000, 1100, "Mail")])
        self.assertEqual([i.confidence for i in out],
                         ["session", "inferred", "session", "inferred", "provisional"])

    def test_app_switch_has_no_home_sliver(self):
        recs = [opened(0, "A"), closed(100.0, "A"), opened(100.2, "B")]
        self.assertEqual(simple(fuse(recs, t(150))), [(0, 100.2, "A"), (100.2, 150, "B")])

    def test_swipe_close_switches_to_the_app_in_front(self):
        recs = [opened(0, "Files"), phone_close(100, "Gemini"), phone_close(130, "Files")]
        self.assertEqual(simple(fuse(recs, t(160))), [(0, 100, "Files"), (100, 130, "Gemini"),
                                                      (130, 160, "Files")])

    def test_late_close_of_previous_app_is_ignored(self):
        recs = [opened(0, "A"), opened(100, "B"), closed(100.4, "A")]
        self.assertEqual(simple(fuse(recs, t(150))), [(0, 100, "A"), (100, 150, "B")])


class Gaps(unittest.TestCase):
    def test_automations_fill_while_the_watcher_was_not_running(self):
        recs = [w(0, "No", "Safari"), w(100, "No", "Safari", "beat"),
                closed(150, "Safari"), opened(1500, "Notes"), closed(1600, "Notes"),
                Record(t(3000), "start", run="2"), w(3002, "No", "Mail")]
        out = fuse(recs, t(3100))
        self.assertEqual(simple(out), [(0, 102.5, "Safari"), (150, 1500, "locked"), (1500, 1600, "Notes"),
                                       (1600, 3002, "locked"), (3002, 3100, "Mail")])


class Invariants(unittest.TestCase):
    def test_order_independent_and_non_overlapping(self):
        rng = random.Random(7)
        apps = ["Safari", "Mail", "Reddit", "Notes"]
        recs, s, state = [], 0.0, None
        for _ in range(300):
            s += rng.choice([0.4, 3, 20, 90, 600, 1200])
            r = rng.random()
            if r < 0.4:
                app = rng.choice(apps)
                recs.append(opened(s, app))
                if rng.random() < 0.8:
                    recs.append(w(s + rng.uniform(0.1, 2.3), "No", app))
                state = app
            elif r < 0.6 and state:
                # Half the closes as the phone sends them: no input, and any app (or none) in front.
                recs.append(closed(s, state) if rng.random() < 0.5 else phone_close(s, rng.choice(apps + [""])))
                if rng.random() < 0.8:
                    recs.append(w(s + rng.uniform(0.1, 2.3), "Yes", state))
            else:
                recs.append(w(s, "No", state or "", rng.choice(["change", "beat"])))
        now = t(s + 100)
        a = fuse(recs, now)
        shuffled = recs[:]
        rng.shuffle(shuffled)
        self.assertEqual(a, fuse(shuffled, now))
        for x, y in zip(a, a[1:]):
            self.assertLessEqual(x.end, y.start)
            self.assertFalse(x.same_activity(y) and x.end == y.start, (x, y))
        self.assertTrue(all(i.seconds > 0 for i in a))
        self.assertTrue(all(i.end <= now for i in a))


if __name__ == "__main__":
    unittest.main()
