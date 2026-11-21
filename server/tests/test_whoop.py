"""WHOOP sync against a fake WHOOP: OAuth, token refresh, paging, updates."""

import io
import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver.whoop import Whoop  # noqa: E402


class FakeWhoop:
    """Answers urlopen calls the way WHOOP's API does (synthetic data)."""

    def __init__(self):
        self.calls = []
        self.refreshes = 0
        self.sleeps = [{"id": f"s{i}", "start": f"2026-11-{i + 1:02d}T07:00:00.000Z",
                        "end": f"2026-11-{i + 1:02d}T14:00:00.000Z", "updated_at": "x",
                        "score": {"sleep_performance_percentage": 80 + i}} for i in range(30)]

    def __call__(self, req, timeout=None):
        url = urllib.parse.urlsplit(req.full_url)
        self.calls.append((req.get_method(), url.path, req.data))
        if url.path.endswith("/oauth2/token"):
            form = urllib.parse.parse_qs(req.data.decode())
            if form["grant_type"] == ["refresh_token"]:
                self.refreshes += 1
            return io.BytesIO(json.dumps({"access_token": f"a{len(self.calls)}", "refresh_token": f"r{len(self.calls)}",
                                          "expires_in": 3600}).encode())
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path.endswith("/profile/basic"):
            return io.BytesIO(json.dumps({"user_id": 1, "first_name": "Test"}).encode())
        if url.path.endswith("/measurement/body"):
            return io.BytesIO(json.dumps({"height_meter": 1.8}).encode())
        records = self.sleeps if url.path.endswith("/activity/sleep") else []
        start = q.get("start", "")
        records = [r for r in records if r["start"] >= start]
        at = int(q.get("nextToken", 0))
        page = records[at:at + int(q.get("limit", 25))]
        nxt = str(at + len(page)) if at + len(page) < len(records) else None
        return io.BytesIO(json.dumps({"records": page, "next_token": nxt}).encode())


class WhoopSync(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.fake = FakeWhoop()
        self.w = Whoop(f"{self.dir.name}/whoop.db", "cid", "secret", "k" * 24, log=lambda *a: None,
                       opener=self.fake)

    def tearDown(self):
        self.dir.cleanup()

    def test_state_is_signed(self):
        self.assertTrue(self.w.state_ok(self.w.state()))
        self.assertFalse(self.w.state_ok("abc.def"))
        self.assertFalse(self.w.state_ok(""))

    def test_auth_url_asks_for_everything(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.w.auth_url("https://relay/tt/whoop/callback")).query)
        for scope in ("offline", "read:sleep", "read:recovery", "read:workout", "read:cycles"):
            self.assertIn(scope, q["scope"][0])

    def test_not_connected_does_nothing(self):
        self.assertFalse(self.w.connected)
        with self.assertRaises(RuntimeError):
            self.w.sync()

    def test_backfill_pages_then_updates(self):
        self.w.connect("code", "https://relay/tt/whoop/callback")
        out = self.w.sync()
        self.assertEqual(out["sleep"], 30)  # two pages
        self.assertEqual(len(self.w.records("sleep", None)), 30)
        self.assertEqual(self.w.records("profile", None)[0]["first_name"], "Test")
        # Nothing changed: nothing stored again.
        self.assertEqual(self.w.sync()["sleep"], 0)
        # A late score update inside the overlap is picked up.
        self.fake.sleeps[-1]["score"]["sleep_performance_percentage"] = 99
        self.assertEqual(self.w.sync()["sleep"], 1)
        self.assertEqual(self.w.records("sleep", None)[-1]["score"]["sleep_performance_percentage"], 99)

    def test_expired_token_is_refreshed(self):
        self.w.connect("code", "https://relay/tt/whoop/callback")
        with self.w.lock, self.w.db:
            self.w.db.execute("UPDATE whoop_auth SET expires = 0")
        self.w.sync()
        self.assertEqual(self.fake.refreshes, 1)


if __name__ == "__main__":
    unittest.main()
