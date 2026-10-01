#!/usr/bin/env python3
"""Webhook receiver for the empirical tests (stdlib only).

Accepts POSTs from the test shortcuts and the Safari probe, stamps each record
with the time it arrived, and appends it to a JSON-lines file.

    python3 receiver.py --out logs/day1.jsonl            # listens on 0.0.0.0:8787
    python3 receiver.py --out logs/day1.jsonl --token s3cret

Point the iPhone at http://<this-machine's-LAN-IP>:8787/log (any path works).

Markers: type a line into this terminal and press Enter. It is logged as
{"kind": "marker", "note": "<your text>"} with the current time, so you can label
each step of a test ("T3 lock via side button") without touching the phone.

Open http://<ip>:8787/ in any browser to see the record count and the last 50
records.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import socket
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Log:
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.count = 0
        self.tail = collections.deque(maxlen=50)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def write(self, rec: dict) -> None:
        line = json.dumps(rec, ensure_ascii=False)
        with self.lock:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            self.count += 1
            self.tail.append(line)
        print(summarize(rec), flush=True)


def summarize(rec: dict) -> str:
    rx = rec.get("rx", "")[11:23]
    kind = str(rec.get("kind", "?"))
    what = (
        rec.get("note")
        or rec.get("app")
        or rec.get("input")
        or rec.get("cur")
        or rec.get("url")
        or rec.get("raw", "")
    )
    extra = []
    for key in ("cur", "run", "tick", "ctx"):
        if key in rec and rec.get(key) != what:
            extra.append(f"{key}={rec[key]}")
    return f"{rx}  {str(rec.get('src', '-')):<8} {kind:<22} {what}  {' '.join(extra)}".rstrip()


def parse_body(body: bytes, content_type: str) -> list:
    """Return a list of dict records from whatever the client sent."""
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return [{}]
    # Shortcuts may send the JSON as text/plain or as a "file"; try JSON first
    # regardless of Content-Type.
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = None
    if isinstance(data, dict):
        return [data]
    if isinstance(data, list):
        return [d if isinstance(d, dict) else {"value": d} for d in data]
    if "application/x-www-form-urlencoded" in content_type:
        return [{k: v[0] if len(v) == 1 else v for k, v in parse_qs(text).items()}]
    # Several JSON lines in one body (e.g. a flushed on-device queue).
    lines = [ln for ln in text.splitlines() if ln.strip()]
    recs = []
    for ln in lines:
        try:
            obj = json.loads(ln)
            recs.append(obj if isinstance(obj, dict) else {"value": obj})
        except json.JSONDecodeError:
            recs.append({"raw": ln})
    return recs or [{"raw": text}]


def make_handler(log: Log, token: str | None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep the terminal for records
            pass

        def handle(self):
            # A TLS handshake starts with byte 0x16: someone typed https://.
            try:
                first = self.connection.recv(1, socket.MSG_PEEK)
            except OSError:
                return
            if first == b"\x16":
                print(f"{self.client_address[0]} tried https:// - use http:// (this receiver has no TLS)", flush=True)
                return
            try:
                super().handle()
            except (ConnectionResetError, BrokenPipeError):
                pass

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

        def _reply(self, code: int, body: str, ctype: str = "application/json") -> None:
            data = body.encode("utf-8")
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if not token:
                return True
            if self.headers.get("Authorization", "") == f"Bearer {token}":
                return True
            qs = parse_qs(urlparse(self.path).query)
            return qs.get("token", [None])[0] == token

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if not self._authorized():
                return self._reply(401, '{"ok": false, "error": "bad token"}')
            with log.lock:
                lines = list(log.tail)
                count = log.count
            page = f"{count} records written to {log.path}\n\n" + "\n".join(reversed(lines))
            self._reply(200, page, "text/plain; charset=utf-8")

        def do_POST(self):
            if not self._authorized():
                return self._reply(401, '{"ok": false, "error": "bad token"}')
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            rx = now_iso()
            for rec in parse_body(body, self.headers.get("Content-Type", "")):
                rec["rx"] = rx
                rec.setdefault("path", urlparse(self.path).path)
                rec["peer"] = self.client_address[0]
                log.write(rec)
            self._reply(200, json.dumps({"ok": True, "n": log.count}))

    return Handler


def read_markers(log: Log) -> None:
    for line in sys.stdin:
        note = line.strip()
        if note:
            ts = now_iso()
            log.write({"src": "receiver", "kind": "marker", "note": note, "ts": ts, "rx": ts})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="logs/receiver.jsonl", help="JSON-lines file to append to")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--token", help="require 'Authorization: Bearer <token>' or ?token=<token>")
    args = ap.parse_args()

    log = Log(args.out)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(log, args.token))
    print(f"listening on http://{args.host}:{args.port}  ->  {args.out}")
    print("type a marker and press Enter to label the current test step\n", flush=True)
    if sys.stdin and sys.stdin.isatty():
        threading.Thread(target=read_markers, args=(log,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
