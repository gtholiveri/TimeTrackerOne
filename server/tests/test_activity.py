"""/tt/activity and /tt/summary (the dashboard's pipeline on the relay), and the read-only key."""

import base64
import http.client
import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver import activity  # noqa: E402
from ttserver.app import Relay, make_handler  # noqa: E402
from ttserver.store import Store  # noqa: E402

UTC = timezone.utc
# 2026-11-01 10:00 in Los Angeles (PDT ended Nov 1 at 02:00, so this is PST, UTC-8).
T0 = datetime(2026, 11, 1, 18, 0, tzinfo=UTC)
NOW = T0 + timedelta(hours=3)


def ev(minute, minutes, **data):
    return {"timestamp": (T0 + timedelta(minutes=minute)).isoformat(), "duration": minutes * 60, "data": data}


class FakeAW:
    """Synthetic buckets: a laptop (window, afk, a host-less Chrome tab bucket) and a phone."""

    def __init__(self):
        self.store = {
            "aw-watcher-window_laptop": [
                ev(0, 30, app="Code.exe", title="app.py"),
                ev(30, 30, app="chrome.exe", title="whatever"),
                ev(60, 30, app="Code.exe", title="app.py"),
            ],
            "aw-watcher-afk_laptop": [ev(0, 50, status="not-afk"), ev(50, 10, status="afk"),
                                      ev(60, 30, status="not-afk")],
            "aw-watcher-web-chrome": [ev(30, 30, url="https://www.youtube.com/watch?v=1", title="Video")],
            "aw-watcher-window_iphone": [ev(40, 20, app="Instagram", title="", tt_confidence="exact"),
                                         ev(70, 5, app="Spotify", title="", tt_confidence="exact")],
            "aw-watcher-afk_iphone": [ev(40, 20, status="not-afk"), ev(60, 10, status="afk"),
                                      ev(70, 5, status="not-afk")],
        }
        self.meta = {
            "aw-watcher-window_laptop": ("currentwindow", "laptop", "aw-watcher-window"),
            "aw-watcher-afk_laptop": ("afkstatus", "laptop", "aw-watcher-afk"),
            "aw-watcher-web-chrome": ("web.tab.current", "unknown", "aw-client-web"),
            "aw-watcher-window_iphone": ("currentwindow", "iphone", "tt-relay"),
            "aw-watcher-afk_iphone": ("afkstatus", "iphone", "tt-relay"),
        }
        self.settings = {
            "startOfDay": "04:00",
            "classes": [
                {"name": ["Work"], "rule": {"type": "none"}, "data": {"score": 10}},
                {"name": ["Work", "Programming"], "rule": {"type": "regex", "regex": "Code\\.exe"}},
                {"name": ["Media", "Social"], "rule": {"type": "regex", "regex": "(?i)instagram"},
                 "data": {"score": -10}},
                {"name": ["Media", "Video"], "rule": {"type": "regex", "regex": "youtube"}, "data": {"score": -10}},
            ],
            "tt_attention": {"priority": "phone", "backgroundApps": ["Spotify"], "homeScreenCounts": True},
        }

    def _req(self, method, path):
        assert method == "GET" and path == "/settings"
        return self.settings

    def buckets(self):
        return {k: {"id": k, "type": t, "hostname": h, "client": c} for k, (t, h, c) in self.meta.items()}

    def events(self, bucket, start, end):
        return [e for e in self.store[bucket]]


class Pipeline(unittest.TestCase):
    def test_devices(self):
        devs = activity.discover(FakeAW().buckets())
        self.assertEqual([(d.host, d.kind) for d in devs], [("iphone", "phone"), ("laptop", "desktop")])
        self.assertEqual(devs[1].web, ["aw-watcher-web-chrome"])

    def test_attention_line(self):
        q = {"start": T0.isoformat(), "end": (T0 + timedelta(hours=2)).isoformat(), "tz": "America/Los_Angeles"}
        _, body = activity.activity(FakeAW(), q)
        got = [(r["start"][11:16], r["end"][11:16], r["device"], r["app"], r["category"], r["rating"])
               for r in body["segments"]]
        self.assertEqual(got, [
            ("10:00", "10:30", "laptop", "Code.exe", "Work > Programming", "productive"),
            # Chrome time takes the tab: YouTube, until the phone (priority) takes over.
            ("10:30", "10:40", "laptop", "chrome.exe", "Media > Video", "distracting"),
            ("10:40", "11:00", "iphone", "Instagram", "Media > Social", "distracting"),
            # Spotify is a background app, so the laptop keeps the attention.
            ("11:00", "11:30", "laptop", "Code.exe", "Work > Programming", "productive"),
        ])
        self.assertEqual(body["segments"][1]["domain"], "youtube.com")

    def test_devices_view_drops_afk_time_and_csv(self):
        q = {"start": T0.isoformat(), "end": (T0 + timedelta(hours=2)).isoformat(), "view": "devices",
             "format": "csv", "tz": "UTC"}
        ctype, body = activity.activity(FakeAW(), q)
        self.assertTrue(ctype.startswith("text/csv"))
        lines = body.strip().split("\n")
        self.assertEqual(lines[0].split(",")[:4], ["start", "end", "seconds", "device"])
        laptop_chrome = [l for l in lines if "chrome.exe" in l]
        self.assertEqual(len(laptop_chrome), 1)
        self.assertIn(",1200.0,", laptop_chrome[0])  # 10:30-10:50; afk from 10:50

    def test_summary(self):
        q = {"start": "2026-11-01", "end": "2026-11-01", "tz": "America/Los_Angeles"}
        body = activity.summary(FakeAW(), q)
        self.assertEqual(body["start"], "2026-11-01T04:00:00-08:00")
        (day,) = body["days"]
        self.assertEqual(day["day"], "2026-11-01")
        self.assertEqual(day["attention_seconds"], 90 * 60)
        self.assertEqual(day["by_rating"], {"productive": 3600, "distracting": 1800})
        self.assertEqual(day["phone_unlocks"], 2)
        self.assertEqual(day["longest_productive_streak_seconds"], 1800)
        self.assertEqual(day["top_domains"], [{"name": "youtube.com", "seconds": 600}])

    def test_range_limits(self):
        with self.assertRaises(ValueError):
            activity.parse_range({"days": "40"}, activity.zone("UTC"), "04:00", NOW)
        with self.assertRaises(ValueError):
            activity.zone("Mars/Olympus")


class ReadKey(unittest.TestCase):
    FULL = "full-key-0123456789abcdef"
    READ = "read-key-0123456789abcdef"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        relay = Relay(Store(str(Path(self.tmp.name) / "tt.db")), None)
        handler = make_handler(relay, self.FULL, "http://127.0.0.1:9", None, read_key=self.READ)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, key, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        conn.request(method, path, body=body, headers={"Authorization": f"Bearer {key}"} if key else {})
        res = conn.getresponse()
        res.read()
        conn.close()
        return res.status

    def test_reads_but_never_writes(self):
        self.assertEqual(self.call("GET", "/tt/state", self.READ), 200)
        self.assertEqual(self.call("GET", f"/tt/lines?key={self.READ}", None), 200)
        # ActivityWatch's read API gets through auth (502: no ActivityWatch in this test).
        self.assertEqual(self.call("GET", "/api/0/buckets/", self.READ), 502)
        self.assertEqual(self.call("POST", "/api/0/query/", self.READ, b"{}"), 502)
        # Writes, the web UI, the dashboard, uploads and labels need another key.
        for method, path in [("DELETE", "/api/0/buckets/x"), ("POST", "/api/0/buckets/x/events"),
                             ("POST", "/api/0/settings/classes"), ("GET", "/"), ("GET", "/app/"),
                             ("POST", "/tt/labels")]:
            self.assertEqual(self.call(method, path, self.READ, b"{}"), 401, (method, path))
        self.assertEqual(self.call("POST", "/tt/ingest", self.READ, b""), 401)
        self.assertEqual(self.call("DELETE", "/api/0/buckets/x", self.FULL), 502)


if __name__ == "__main__":
    unittest.main()
