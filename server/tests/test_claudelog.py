"""claudelog.py: storing Claude messages and fusing them into Claude blocks."""

import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ttserver import claudelog  # noqa: E402
from ttserver.labels import Labeler, Provider  # noqa: E402
from ttserver.store import Store  # noqa: E402
from test_activity import T0, FakeAW, ev  # noqa: E402


def msg(minute, who, text, session="s1", title="Fix the watcher"):
    return {"ts": (T0 + timedelta(minutes=minute)).isoformat(), "surface": "local", "session": session,
            "title": title, "who": who, "text": text}


class ClaudeLog(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(f"{self.dir.name}/tt.db")

    def tearDown(self):
        self.dir.cleanup()

    def test_ingest_dedupes_and_updates_titles(self):
        body = json.dumps([msg(1, "you", "why is it dead", title=None), msg(2, "claude", "Because...")])
        self.assertEqual(claudelog.ingest(self.store, body)["new"], 2)
        again = claudelog.ingest(self.store, json.dumps([msg(1, "you", "why is it dead")]))
        self.assertEqual(again["new"], 0)
        got = claudelog.events(self.store, T0, T0 + timedelta(hours=1))
        self.assertEqual([(e["who"], e["title"]) for e in got], [("you", "Fix the watcher"), ("claude", "Fix the watcher")])
        self.assertEqual(len(claudelog.events(self.store, T0, T0 + timedelta(hours=1), "you")), 1)

    def test_blocks(self):
        aw = FakeAW()
        # Claude desktop on the laptop at 0-20 and 24-30 (one block), claude.ai at 80-90 with nothing typed.
        aw.store["aw-watcher-window_laptop"] = [
            ev(0, 20, app="claude.exe", title="Claude"), ev(20, 4, app="Code.exe", title="app.py"),
            ev(24, 6, app="claude.exe", title="Claude"), ev(30, 50, app="Code.exe", title="app.py"),
            ev(80, 10, app="chrome.exe", title="Claude"),
        ]
        aw.store["aw-watcher-afk_laptop"] = [ev(0, 90, status="not-afk")]
        aw.store["aw-watcher-web-chrome"] = [ev(80, 10, url="https://claude.ai/chat/1", title="Claude")]
        claudelog.ingest(self.store, json.dumps([msg(5, "you", "make TT Watch restart itself"),
                                                 msg(6, "claude", "Sure."), msg(26, "you", "no, one key")]))
        chain = [Provider("fake", "http://x", "m", None)]

        def call(p, system, user):
            ids = json.loads(user)
            return json.dumps({b: {"label": "TT Watch keep-alive", "summary": "Fixing tracker tooling.",
                                   "kind": "tinkering"} for b in ids})

        labeler = Labeler(f"{self.dir.name}/labels.db", chain=chain, call=call)
        q = {"start": "2026-11-01T10:00:00-08:00", "end": "2026-11-01T11:40:00-08:00", "tz": "America/Los_Angeles"}
        out = claudelog.blocks(aw, self.store, labeler, q)
        self.assertEqual(out["count"], 2)
        first, second = out["blocks"]
        self.assertEqual(first["seconds"], 26 * 60)
        self.assertEqual([t["text"] for t in first["typed"]], ["make TT Watch restart itself", "no, one key"])
        self.assertEqual(first["sessions"][0]["you"], 2)
        self.assertEqual((first["label"], first["kind"]), ("TT Watch keep-alive", "tinkering"))
        self.assertIsNone(second["label"])  # nothing typed: no label
        # Cached: a second call asks nobody.
        labeler.call = lambda *a: self.fail("asked the model again")
        self.assertEqual(claudelog.blocks(aw, self.store, labeler, q)["blocks"][0]["kind"], "tinkering")


class RetiredModel(unittest.TestCase):
    def test_switches_to_a_listed_model_on_404(self):
        from unittest import mock
        from ttserver import labels
        p = Provider("gemini", "https://g/v1beta/openai/chat/completions", "old-model", "k")
        seen = []

        def call(prov, system, user):
            seen.append(prov.model)
            if prov.model == "old-model":
                raise labels.ProviderError("HTTP 404")
            return "ok"

        with tempfile.TemporaryDirectory() as d:
            lab = Labeler(f"{d}/l.db", chain=[p], call=call)
            with mock.patch.object(labels, "current_model", return_value="gemini-9-flash-lite"):
                text, used = lab.complete(p, "s", "u")
        self.assertEqual((text, used.model, seen), ("ok", "gemini-9-flash-lite", ["old-model", "gemini-9-flash-lite"]))
        self.assertEqual(lab.chain[0].model, "gemini-9-flash-lite")


if __name__ == "__main__":
    unittest.main()
