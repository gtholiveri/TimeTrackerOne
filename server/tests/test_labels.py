"""Block labels: the content key, parsing the model's answer, the cache, batching,
falling back between providers, and the /tt/labels route. No network: the
providers are faked at urllib.request.urlopen."""

import base64
import http.client
import io
import json
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ttserver import labels  # noqa: E402
from ttserver.app import Relay, make_handler  # noqa: E402
from ttserver.labels import Labeler, Provider, clean_items, content_key, content_norm, parse_labels  # noqa: E402
from ttserver.store import Store  # noqa: E402

A = Provider("alpha", "https://alpha.example/v1/chat/completions", "a-small", "k-a")
B = Provider("beta", "https://beta.example/v1/chat/completions", "b-small", None)


def item(subject, seconds, title="", app=None, category="Work"):
    return {"subject": subject, "app": app or subject, "title": title, "seconds": seconds, "category": category}


def block(bid, *items):
    return {"id": bid, "items": list(items)}


WRITING = [item("overleaf.com", 1500, "Lab report - Online LaTeX Editor", app="Chrome"), item("Slack", 200, "general")]
CAD = [item("SOLIDWORKS", 3000, "bracket.SLDPRT")]
SHOW = [item("disneyplus.com", 2400, "Andor | Disney+", app="Chrome", category="Media")]


class FakeAPI:
    """Stands in for urlopen: answers each provider with a function of the request."""

    def __init__(self, answers):
        self.answers = answers  # provider url -> callable(ids) -> reply text, or an int HTTP status
        self.calls: list[tuple[str, list[str], dict]] = []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data)
        blocks = json.loads(body["messages"][1]["content"])
        self.calls.append((req.full_url, list(blocks), dict(req.header_items())))
        answer = self.answers[req.full_url]
        if isinstance(answer, int):
            raise urllib.error.HTTPError(req.full_url, answer, "nope", {"Retry-After": "30"}, io.BytesIO(b""))
        text = answer(blocks)
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": text}}]}).encode())


def names(blocks):
    """A well-behaved model: a label from each block's first subject."""
    return json.dumps({bid: f"Busy in {items[0]['subject']}" for bid, items in blocks.items()})


class Content(unittest.TestCase):
    def test_items_capped_and_cut(self):
        many = [item(f"app{i}", 10 * i, "x" * 200) for i in range(10)]
        out = clean_items(many + ["junk", {"seconds": "nan?"}])
        self.assertEqual(len(out), labels.MAX_ITEMS)
        self.assertEqual(out[0]["subject"], "app9")
        self.assertEqual(len(out[0]["title"]), labels.MAX_TITLE)

    def test_key_ignores_small_changes(self):
        base = content_key(clean_items(WRITING))
        grown = [dict(WRITING[0], seconds=1700), dict(WRITING[1], seconds=180)]
        self.assertEqual(content_key(clean_items(grown)), base)
        counted = [dict(WRITING[0], title="(3) Lab report - Online LaTeX Editor"), WRITING[1]]
        self.assertEqual(content_key(clean_items(counted)), base)
        blip = WRITING + [item("Spotify", 20, "song")]
        self.assertEqual(content_key(clean_items(blip)), base)

    def test_key_follows_real_changes(self):
        base = content_key(clean_items(WRITING))
        self.assertNotEqual(content_key(clean_items(CAD)), base)
        even = [WRITING[0], dict(WRITING[1], seconds=1500)]
        self.assertNotEqual(content_key(clean_items(even)), base)

    def test_norm_matches_the_dashboard(self):
        # Same string as labels.test.ts expects from contentNorm.
        self.assertEqual(content_norm(clean_items(WRITING)), "overleaf.com|lab report online latex editor")
        self.assertEqual(content_norm(clean_items(SHOW + [item("Slack", 900, "#general (2)")])),
                         "disneyplus.com|andor disney\nslack|general")


class Parsing(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_labels('{"b1": "Writing in Overleaf", "b2": "CAD in SolidWorks"}', ["b1", "b2"]),
                         {"b1": "Writing in Overleaf", "b2": "CAD in SolidWorks"})

    def test_fences_reasoning_and_prose(self):
        text = '<think>hmm {"b1": "no"}</think>Sure!\n```json\n{"b1": "Writing in Overleaf."}\n```'
        self.assertEqual(parse_labels(text, ["b1"]), {"b1": "Writing in Overleaf"})

    def test_broken_json_still_read_line_by_line(self):
        text = '{"b1": "Writing in Overleaf",\n "b2": "CAD in SolidWorks",\n "b3": '
        self.assertEqual(parse_labels(text, ["b1", "b2", "b3"]),
                         {"b1": "Writing in Overleaf", "b2": "CAD in SolidWorks"})

    def test_garbage_and_unknown_ids(self):
        self.assertEqual(parse_labels("I can't help with that.", ["b1"]), {})
        self.assertEqual(parse_labels('{"b9": "x", "b1": 7, "b2": ""}', ["b1", "b2"]), {})

    def test_long_labels_cut(self):
        out = parse_labels('{"b1": "Writing a very long lab report in Overleaf all afternoon"}', ["b1"])
        self.assertEqual(out["b1"], "Writing a very long lab")


class Labeling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = str(Path(self.tmp.name) / "labels.db")

    def tearDown(self):
        self.tmp.cleanup()

    def run_with(self, answers, chain, blocks, labeler=None):
        api = FakeAPI(answers)
        labeler = labeler or Labeler(self.db, chain)
        with mock.patch.object(urllib.request, "urlopen", api):
            return labeler.label(blocks), api.calls, labeler

    def test_one_call_for_many_blocks_then_cached(self):
        blocks = [block("w", *WRITING), block("c", *CAD), block("s", *SHOW)]
        out, calls, labeler = self.run_with({A.url: names}, [A], blocks)
        self.assertEqual(out, {"labels": {"w": "Busy in overleaf.com", "c": "Busy in SOLIDWORKS",
                                          "s": "Busy in disneyplus.com"}, "model": "alpha/a-small"})
        self.assertEqual([(url, ids) for url, ids, _ in calls], [(A.url, ["b1", "b2", "b3"])])
        self.assertEqual(calls[0][2]["Authorization"], "Bearer k-a")
        # A refresh: the live block grew a little and got a new id. No new call.
        grown = [block("w2", dict(WRITING[0], seconds=1650), WRITING[1]), block("c", *CAD)]
        out, calls, _ = self.run_with({A.url: names}, [A], grown, Labeler(self.db, [A]))
        self.assertEqual(calls, [])
        self.assertEqual(out["labels"], {"w2": "Busy in overleaf.com", "c": "Busy in SOLIDWORKS"})

    def test_batches(self):
        blocks = [block(f"x{i}", item(f"app{i}", 600)) for i in range(labels.BATCH + 5)]
        out, calls, _ = self.run_with({A.url: names}, [A], blocks)
        self.assertEqual([len(ids) for _, ids, _ in calls], [labels.BATCH, 5])
        self.assertEqual(len(out["labels"]), labels.BATCH + 5)

    def test_same_content_asked_once(self):
        out, calls, _ = self.run_with({A.url: names}, [A], [block("1", *CAD), block("2", *CAD)])
        self.assertEqual(len(calls[0][1]), 1)
        self.assertEqual(set(out["labels"]), {"1", "2"})

    def test_falls_back_on_rate_limit_and_skips_while_cooling(self):
        out, calls, labeler = self.run_with({A.url: 429, B.url: names}, [A, B], [block("c", *CAD)])
        self.assertEqual(out, {"labels": {"c": "Busy in SOLIDWORKS"}, "model": "beta/b-small"})
        self.assertNotIn("Authorization", calls[1][2])
        _, calls, _ = self.run_with({A.url: 429, B.url: names}, [A, B], [block("s", *SHOW)], labeler)
        self.assertEqual([url for url, _, _ in calls], [B.url])  # alpha is cooling down

    def test_next_provider_gets_only_what_was_missed(self):
        def half(blocks):
            return json.dumps({"b1": "Writing in Overleaf"}) + " and b2 is hard"
        out, calls, _ = self.run_with({A.url: half, B.url: names}, [A, B],
                                      [block("w", *WRITING), block("c", *CAD)])
        self.assertEqual(out["labels"], {"w": "Writing in Overleaf", "c": "Busy in SOLIDWORKS"})
        self.assertEqual([len(ids) for _, ids, _ in calls], [2, 1])

    def test_everyone_fails(self):
        out, _, labeler = self.run_with({A.url: 500, B.url: lambda b: "no"}, [A, B], [block("c", *CAD)])
        self.assertEqual(out, {"labels": {}, "model": None})
        self.assertEqual(labeler.cached([content_key(clean_items(CAD))]), {})  # failures aren't cached

    def test_timeout_moves_on(self):
        def slow(blocks):
            raise TimeoutError("timed out")
        out, _, _ = self.run_with({A.url: slow, B.url: names}, [A, B], [block("c", *CAD)])
        self.assertEqual(out["model"], "beta/b-small")

    def test_bad_input_ignored(self):
        out, calls, _ = self.run_with({A.url: names}, [A], [{"id": 3}, "x", block("e"), {"items": CAD}])
        self.assertEqual((out, calls), ({"labels": {}, "model": None}, []))
        self.assertEqual(Labeler(self.db, [A]).label("nope"), {"labels": {}, "model": None})


class Chain(unittest.TestCase):
    def test_keyed_first_then_keyless(self):
        chain = labels.providers({"TT_LLM_GEMINI_KEY": "g", "TT_LLM_GROQ_KEY": "q", "TT_LLM_GROQ_MODEL": "m"})
        self.assertEqual([p.name for p in chain][:2], ["groq", "gemini"])
        self.assertEqual((chain[0].model, chain[0].key), ("m", "q"))
        self.assertTrue(all(p.key is None for p in chain[2:]))
        self.assertGreater(len(chain), 2)

    def test_keyless_can_be_turned_off(self):
        self.assertEqual(labels.providers({"TT_LLM_KEYLESS": "0"}), [])


class Route(unittest.TestCase):
    KEY = "labels-key-0123456789abcdef"
    INGEST = "ingest-key-0123456789abcdef"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self.tmp.name)
        labeler = Labeler(str(root / "labels.db"), [A])
        labeler.call = lambda p, system, user: names(json.loads(user))
        handler = make_handler(Relay(Store(str(root / "tt.db")), None), self.KEY, "http://127.0.0.1:9", None,
                               self.INGEST, dashboard=str(root / "dist"), labeler=labeler)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def post(self, body, key):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Basic " + base64.b64encode(f"me:{key}".encode()).decode()
        conn.request("POST", "/tt/labels", body=body, headers=headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data

    def test_labels(self):
        status, data = self.post(json.dumps({"blocks": [block("c", *CAD)]}), self.KEY)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"labels": {"c": "Busy in SOLIDWORKS"}, "model": "alpha/a-small"})

    def test_needs_the_full_key(self):
        body = json.dumps({"blocks": []})
        self.assertEqual(self.post(body, None)[0], 401)
        self.assertEqual(self.post(body, self.INGEST)[0], 401)

    def test_bad_body(self):
        self.assertEqual(self.post("[1, 2]", self.KEY)[0], 400)
        self.assertEqual(self.post("{nope", self.KEY)[0], 400)


if __name__ == "__main__":
    unittest.main()
