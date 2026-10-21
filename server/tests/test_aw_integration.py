"""End to end against a real aw-server-rust: phone lines in over HTTP, events
out in ActivityWatch, and the web UI proxied behind the key.

Needs the aw-server binary: set AW_SERVER=/path/to/aw-server (skipped otherwise).
"""

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver import awsync  # noqa: E402
from ttserver.app import Relay, make_handler  # noqa: E402
from ttserver.store import Store  # noqa: E402

AW_SERVER = os.environ.get("AW_SERVER") or shutil.which("aw-server")
KEY = "test-key-0123456789abcdef"
DEV = "Test iPhone"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def line(ts, kind, **kv):
    fields = {"src": "ios", "kind": kind, "dev": DEV,
              "ts": ts.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + "+00:00", **kv}
    return "tt|" + "|".join(f"{k}={v}" for k, v in fields.items())


@unittest.skipUnless(AW_SERVER and os.path.exists(AW_SERVER), "set AW_SERVER to an aw-server-rust binary")
class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.aw_port = free_port()
        cls.aw = subprocess.Popen([AW_SERVER, "--host", "127.0.0.1", "--port", str(cls.aw_port),
                                   "--dbpath", os.path.join(cls.tmp, "aw.db"), "--no-legacy-import"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        aw_url = f"http://127.0.0.1:{cls.aw_port}"
        cls.client = awsync.AW(aw_url)
        for _ in range(100):
            try:
                cls.client.info()
                break
            except Exception:
                time.sleep(0.1)
        cls.relay = Relay(Store(os.path.join(cls.tmp, "tt.db")), cls.client)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.relay, KEY, aw_url, None))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.aw.terminate()
        cls.aw.wait()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def http(self, method, path, body=None, headers=None):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_phone_lines_become_aw_events(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        t = lambda s: now - timedelta(seconds=600) + timedelta(seconds=s)  # noqa: E731
        events = [line(t(0), "open", input="Safari", cur="Safari"),
                  line(t(100), "close", input="Safari", cur="Safari"),
                  line(t(100.2), "open", input="Mail", cur="Mail"),
                  line(t(200), "close", input="Mail", cur="Mail")]
        watch = [line(t(1), "change", run="1", tick=1, locked="No", cur="Safari"),
                 line(t(101), "change", run="1", tick=44, locked="No", cur="Mail"),
                 line(t(201), "change", run="1", tick=88, locked="Yes", cur="Mail"),
                 line(t(500), "change", run="1", tick=200, locked="No", cur="Mail")]
        q = "/tt/ingest?key={}&file={}&lines={}&mode=tail&dev=Test%20iPhone"
        self.assertEqual(self.http("POST", q.format("nope", "tt-events.txt", 4), "\n".join(events).encode())[0], 401)
        status, body = self.http("POST", q.format(KEY, "tt-events.txt", 4), "\n".join(events).encode())
        self.assertEqual((status, body), (200, b"ok\n"))
        status, body = self.http("POST", q.format(KEY, "tt-watch.txt", 10), "\n".join(watch).encode())
        self.assertEqual(body, b"full\n")  # 6 earlier lines missing
        self.http("POST", q.format(KEY, "tt-watch.txt", 4).replace("tail", "full"), "\n".join(watch).encode())

        self.relay.sync_once()
        host = awsync.hostname(DEV)
        win = self.client.events(f"aw-watcher-window_{host}", now - timedelta(hours=1), now + timedelta(hours=1))
        apps = sorted((e["timestamp"], e["data"]["app"], round(e["duration"], 1)) for e in win)
        self.assertEqual([a[1:] for a in apps[:2]], [("Safari", 100.2), ("Mail", 99.8)])
        self.assertEqual(apps[2][1], "Mail")  # the live tail, from the unlock to now
        self.assertAlmostEqual(apps[2][2], 100, delta=5)
        afk = self.client.events(f"aw-watcher-afk_{host}", now - timedelta(hours=1), now + timedelta(hours=1))
        spans = sorted((e["timestamp"], e["data"]["status"], round(e["duration"], 1)) for e in afk)
        self.assertEqual([x[1:] for x in spans[:2]], [("not-afk", 200.0), ("afk", 300.0)])
        self.assertEqual(spans[2][1], "not-afk")

        # A second pass only replaces the live tail, which grew to the new now.
        changes = self.relay.sync_once()
        self.assertTrue(all(ins <= 1 and dels <= 1 for ins, dels in changes[DEV].values()), changes)

        # The state endpoint shows the live tail.
        status, body = self.http("GET", f"/tt/state?key={KEY}")
        state = json.loads(body)["devices"][DEV]
        self.assertEqual((state["current"]["app"], state["current"]["confidence"]), ("Mail", "provisional"))

    def test_safari_pages_reach_the_web_bucket(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        t = lambda s: now - timedelta(seconds=300) + timedelta(seconds=s)  # noqa: E731
        phone = [line(t(0), "open", input="Safari", cur="Safari"), line(t(1), "change", locked="No", cur="Safari"),
                 line(t(60), "close", input="Safari", cur="Safari"), line(t(61), "change", locked="Yes", cur="Safari")]
        self.http("POST", f"/tt/ingest?key={KEY}", "\n".join(phone).encode())
        pages = [{"src": "safari", "kind": k, "page": "p1", "seq": i, "url": "https://news.example/a",
                  "title": "A story", "vis": "visible", "ts": t(s).isoformat()}
                 for i, (k, s) in enumerate([("show", 10), ("beat", 25), ("beat", 40), ("beat", 55)])]
        status, body = self.http("POST", f"/tt/safari?key={KEY}", json.dumps(pages).encode(),
                                 {"Content-Type": "text/plain"})
        self.assertEqual(json.loads(body)["new"], 4)
        self.relay.sync_once()
        host = awsync.hostname(DEV)
        web = self.client.events(f"aw-watcher-web-safari_{host}", t(0), t(300))
        self.assertEqual([(e["data"]["url"], round(e["duration"])) for e in web], [("https://news.example/a", 50)])
        win = self.client.events(f"aw-watcher-window_{host}", t(0), t(70))
        titles = sorted((e["timestamp"], e["data"]["title"]) for e in win if e["data"]["app"] == "Safari")
        self.assertIn("A story", [x[1] for x in titles])
        status, body = self.http("GET", f"/tt/lines?key={KEY}&source=safari")
        self.assertEqual(len(body.decode().splitlines()), 4)

    def test_event_reaching_into_the_range_is_updated(self):
        from ttserver.fusion import Interval
        now = datetime.now(timezone.utc).replace(microsecond=0)
        since = now - timedelta(minutes=90)
        long_use = Interval(now - timedelta(hours=2), now - timedelta(hours=1), "app", "Kindle", "tick")
        awsync.sync_device(self.client, "Long Phone", [long_use], [], since, now)
        longer = Interval(long_use.start, now - timedelta(minutes=30), "app", "Kindle", "provisional")
        awsync.sync_device(self.client, "Long Phone", [longer], [], since, now)
        win = self.client.events("aw-watcher-window_Long-Phone", now - timedelta(hours=3), now)
        self.assertEqual([round(e["duration"]) for e in win], [5400])

    def test_proxy_needs_the_key(self):
        self.assertEqual(self.http("GET", "/api/0/info")[0], 401)
        auth = "Basic " + base64.b64encode(f"me:{KEY}".encode()).decode()
        status, body = self.http("GET", "/api/0/info", headers={"Authorization": auth})
        self.assertEqual(status, 200)
        self.assertIn("hostname", json.loads(body))


if __name__ == "__main__":
    unittest.main()
