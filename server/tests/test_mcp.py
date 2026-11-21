"""The relay's MCP endpoint: handshake, tools, auth, and that the key never hits the log."""

import http.client
import io
import json
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout, redirect_stderr
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver.app import Relay, ingest, make_handler  # noqa: E402
from ttserver.store import Store  # noqa: E402

KEY, READ = "k" * 24, "r" * 24
LINES = ("tt|src=ios|kind=loc|dev=Phone|ts=2099-01-01 10:00:00.000-08:00|lat=34.02|lon=-118.28|acc=5\n"
         "tt|src=ios|kind=motion|dev=Phone|ts=2099-01-01 10:00:01.000-08:00|activity=walking|conf=high\n"
         "tt|src=ios|kind=open|dev=Phone|ts=2099-01-01 10:00:02.000-08:00|input=|cur=Safari")


class MCP(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.relay = Relay(Store(f"{self.dir.name}/tt.db"), None)
        ingest(self.relay, {}, LINES)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(
            self.relay, KEY, "http://127.0.0.1:1", None, read_keys={"hermes": READ}))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.dir.cleanup()

    def post(self, path, body, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.srv.server_port)
        c.request("POST", path, json.dumps(body), {"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse()
        return r.status, r.read()

    def call(self, name, **args):
        st, body = self.post(f"/mcp/{READ}", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                              "params": {"name": name, "arguments": args}})
        self.assertEqual(st, 200)
        return json.loads(body)["result"]

    def test_handshake_and_tools(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            st, body = self.post(f"/mcp/{READ}", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
            self.assertEqual(json.loads(body)["result"]["serverInfo"]["name"], "timetracker")
            self.assertEqual(self.post(f"/mcp/{READ}", {"jsonrpc": "2.0", "method": "notifications/initialized"})[0], 202)
            st, body = self.post("/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                                 {"Authorization": f"Bearer {READ}"})
        names = {t["name"] for t in json.loads(body)["result"]["tools"]}
        self.assertTrue({"get_live_state", "get_daily_summary", "get_activity", "get_location",
                         "get_motion", "get_whoop", "get_raw_lines"} <= names)
        self.assertNotIn(READ, out.getvalue())

    def test_bad_key(self):
        self.assertEqual(self.post("/mcp/not-a-key-at-all-xx", {"jsonrpc": "2.0", "id": 1, "method": "ping"})[0], 404)
        self.assertEqual(self.post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"})[0], 401)

    def test_streams(self):
        loc = json.loads(self.call("get_location", hours=1e7)["content"][0]["text"])
        self.assertEqual((loc[0]["lat"], loc[0]["lon"]), ("34.02", "-118.28"))
        motion = json.loads(self.call("get_motion", hours=1e7)["content"][0]["text"])
        self.assertEqual(motion[0]["activity"], "walking")
        raw = json.loads(self.call("get_raw_lines", hours=1e7, kinds=["open"])["content"][0]["text"])
        self.assertEqual(len(raw), 1)
        self.assertTrue(self.call("get_whoop")["isError"])  # not configured here


if __name__ == "__main__":
    unittest.main()
