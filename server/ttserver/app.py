"""The relay: receives the phone's lines, fuses them, and keeps ActivityWatch
up to date. Also serves the ActivityWatch web UI behind the same key.

Endpoints (KEY is TT_KEY; pass it as ?key=, a bearer token, or the password
of HTTP basic auth). TT_INGEST_KEY, if set, works for the two POST endpoints
only, so the key stored on the phone can't read anything back:

    POST /tt/ingest?key=KEY&file=NAME&lines=N&mode=tail|full&dev=DEVICE
        Body: raw tt|... lines from one of the phone's log files. With
        mode=tail the body is the last few lines of a file that has N lines;
        the answer is "full" if the server is missing lines before those,
        and TT Sync then sends the whole file with mode=full. Otherwise "ok".
    POST /tt/safari?key=KEY
        Body: the Safari extension's records, a JSON array or one per line.
    GET  /tt/state?key=KEY[&hours=6]
        The fused timeline per device, newest last, with the live state.
    GET  /tt/lines?key=KEY&source=ios|safari[&hours=24]
        The raw lines received, oldest first, for debugging.
    GET  /tt/health
    Anything else: proxied to ActivityWatch (the web UI and its API).
"""

from __future__ import annotations

import base64
import hmac
import http.client
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import awsync
from .fusion import fuse
from .lines import parse_line, to_record
from .store import Store, iso_utc
from .web import web_segments

RECONCILE_RECENT = timedelta(hours=6)   # always re-derive at least this much
CONTEXT = timedelta(hours=24)           # records loaded before the reconcile range
ACTIVE_DEVICE = timedelta(days=7)       # devices quiet for longer are left alone
INTERVAL = 20                           # seconds between fusion passes
MAX_BODY = 8 * 1024 * 1024
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
               "trailers", "transfer-encoding", "upgrade", "host", "authorization", "content-length"}


def log(*args):
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *args, flush=True)


class Relay:
    """Runs fusion and the ActivityWatch sync, after each ingest and every INTERVAL s."""

    def __init__(self, store: Store, aw: awsync.AW | None):
        self.store = store
        self.aw = aw
        self.dirty: dict[str, datetime] = {}
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.last_error: str | None = None
        self.last_sync: float | None = None

    def mark(self, dev: str, earliest: datetime | None) -> None:
        if earliest is None:
            return
        with self.lock:
            if dev not in self.dirty or earliest < self.dirty[dev]:
                self.dirty[dev] = earliest
        self.wake.set()

    def devices(self, now: datetime) -> list[str]:
        cutoff = iso_utc(now - ACTIVE_DEVICE)
        return [d for d, newest in self.store.devices("ios") if newest >= cutoff]

    def timeline(self, dev: str, since: datetime, now: datetime, primary: bool):
        """Fused intervals and Safari pages for one device, from records since `since`."""
        records = [r for _, d in self.store.lines("ios", since, dev) if (r := to_record(d))]
        intervals = fuse(records, now)
        safari = [d for owner, d in self.store.lines("safari", since)
                  if owner == dev or (owner is None and primary)]
        return intervals, web_segments(safari, now)

    def sync_once(self, now: datetime | None = None) -> dict:
        now = now or datetime.now(timezone.utc)
        results = {}
        with self.lock:
            dirty, self.dirty = self.dirty, {}
        try:
            for i, dev in enumerate(self.devices(now)):
                start = min(dirty.get(dev, now), now - RECONCILE_RECENT)
                intervals, pages = self.timeline(dev, start - CONTEXT, now, primary=i == 0)
                if intervals:
                    # The newest interval is still changing (the provisional tail),
                    # so its start is always inside the reconciled range.
                    start = min(start, intervals[-1].start)
                if self.aw is not None:
                    results[dev] = awsync.sync_device(self.aw, dev, intervals, pages, start, now + timedelta(days=1))
        except Exception:
            for dev, ts in dirty.items():  # redo the same ranges next time
                self.mark(dev, ts)
            raise
        self.last_sync = time.time()
        return results

    def run_forever(self) -> None:
        while True:
            self.wake.wait(INTERVAL)
            self.wake.clear()
            try:
                changes = self.sync_once()
                if any(n for r in changes.values() for pair in r.values() for n in pair):
                    log("aw sync", json.dumps(changes))
                self.last_error = None
            except Exception as e:  # keep relaying; report on /tt/health
                self.last_error = f"{type(e).__name__}: {e}"
                log("aw sync failed:", self.last_error)
                time.sleep(5)


def state_json(relay: Relay, hours: float) -> dict:
    now = datetime.now(timezone.utc)
    out = {"now": now.isoformat(), "devices": {}}
    for i, dev in enumerate(relay.devices(now)):
        intervals, pages = relay.timeline(dev, now - timedelta(hours=hours) - CONTEXT, now, primary=i == 0)
        shown = [iv for iv in intervals if iv.end >= now - timedelta(hours=hours)]
        last_page = pages[-1] if pages else None
        out["devices"][dev] = {
            "host": awsync.hostname(dev),
            "current": _iv(shown[-1]) if shown else None,
            "safari_page": {"url": last_page.url, "title": last_page.title, "end": last_page.end.isoformat()}
            if last_page else None,
            "last_received": relay.store.last_received("ios", dev),
            "intervals": [_iv(iv) for iv in shown],
        }
    return out


def _iv(iv) -> dict:
    return {"start": iv.start.isoformat(), "end": iv.end.isoformat(), "seconds": round(iv.seconds, 1),
            "state": iv.state, "app": iv.app, "confidence": iv.confidence}


def make_handler(relay: Relay, key: str, aw_url: str, aw_api_key: str | None, ingest_key: str | None = None):
    aw = urllib.parse.urlsplit(aw_url)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "tt-relay"

        def log_message(self, fmt, *args):
            if not getattr(self, "path", "").startswith("/tt/health"):
                headers = getattr(self, "headers", None) or {}
                log(headers.get("Fly-Client-IP") or headers.get("X-Forwarded-For") or self.address_string(),
                    re.sub(r"key=[^&\s\"]*", "key=…", fmt % args))

        # ------------------------------------------------------------ helpers

        def query(self) -> dict[str, str]:
            return {k: v[-1] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).items()}

        def authorized(self, ingest: bool = False) -> bool:
            """The full key opens everything; the ingest key (if set) only the upload endpoints."""
            supplied = self.query().get("key")
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                supplied = auth[7:].strip()
            elif auth.startswith("Basic "):
                try:
                    supplied = base64.b64decode(auth[6:]).decode().partition(":")[2]
                except Exception:
                    pass
            if not supplied:
                return False
            keys = [key] + ([ingest_key] if ingest and ingest_key else [])
            return any(hmac.compare_digest(supplied.encode(), k.encode()) for k in keys)

        def body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("body too large")
            return self.rfile.read(n) if n else b""

        def send(self, code: int, payload, content_type="text/plain; charset=utf-8", extra=None):
            data = payload if isinstance(payload, bytes) else (
                payload.encode() if isinstance(payload, str) else json.dumps(payload).encode())
            if not isinstance(payload, (bytes, str)):
                content_type = "application/json"
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        # ------------------------------------------------------------ routes

        def do_OPTIONS(self):
            if self.path.startswith("/tt/"):
                self.send(204, b"", extra={"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                                           "Access-Control-Allow-Headers": "Authorization, Content-Type",
                                           "Access-Control-Max-Age": "86400"})
            else:
                self.proxy()

        def do_GET(self):
            path = urllib.parse.urlsplit(self.path).path
            if path == "/tt/health":
                return self.send(200, {"ok": relay.last_error is None, "error": relay.last_error,
                                       "last_sync": relay.last_sync})
            if path == "/tt/state":
                if not self.authorized():
                    return self.send(401, "bad key\n")
                return self.send(200, state_json(relay, float(self.query().get("hours", 6))))
            if path == "/tt/lines":
                if not self.authorized():
                    return self.send(401, "bad key\n")
                q = self.query()
                since = datetime.now(timezone.utc) - timedelta(hours=float(q.get("hours", 24)))
                return self.send(200, "".join(r + "\n" for r in relay.store.raw(q.get("source", "ios"), since)))
            self.proxy()

        def do_POST(self):
            path = urllib.parse.urlsplit(self.path).path
            if path in ("/tt/ingest", "/tt/safari"):
                if not self.authorized(ingest=True):
                    return self.send(401, "bad key\n")
                try:
                    body = self.body().decode("utf-8", "replace")
                except ValueError as e:
                    return self.send(413, f"{e}\n")
                if path == "/tt/ingest":
                    return self.send(200, ingest(relay, self.query(), body) + "\n")
                return self.send(200, ingest_safari(relay, self.query(), body))
            self.proxy()

        def do_DELETE(self):
            self.proxy()

        def do_PUT(self):
            self.proxy()

        def proxy(self):
            if not self.authorized():
                return self.send(401, "TimeTracker: sign in with any user name and the key as password.\n",
                                 extra={"WWW-Authenticate": 'Basic realm="TimeTracker"'})
            try:
                body = self.body()
                conn = http.client.HTTPConnection(aw.hostname, aw.port or 80, timeout=60)
                headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
                headers["Host"] = "localhost:5600"
                if aw_api_key:
                    headers["Authorization"] = f"Bearer {aw_api_key}"
                conn.request(self.command, self.path, body=body or None, headers=headers)
                res = conn.getresponse()
                data = res.read()
                conn.close()
            except Exception as e:
                return self.send(502, f"ActivityWatch unreachable: {e}\n")
            self.send_response(res.status)
            for k, v in res.getheaders():
                if k.lower() not in HOP_HEADERS:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

    return Handler


def ingest(relay: Relay, q: dict[str, str], body: str) -> str:
    """Store a batch of phone lines; answer "full" if TT Sync should send the whole file."""
    raw = body.split("\n") if body else []
    devs = sorted({d["dev"] for d in map(parse_line, raw) if d and d.get("dev")})
    new, earliest = relay.store.add_lines(raw, "ios", q.get("dev"))
    for dev in devs or ([q["dev"]] if q.get("dev") else []):
        relay.mark(dev, earliest)
    name, mode = q.get("file"), q.get("mode", "full")
    if not name:
        return "ok"
    dev = q.get("dev") or (devs[0] if devs else "unknown")
    try:
        total = int(float(q["lines"])) if q.get("lines") else None
    except ValueError:
        total = None
    if mode == "tail" and total is not None:
        if relay.store.known(dev, name) < total - len(raw):
            return "full"  # lines before this tail never arrived
    relay.store.set_known(dev, name, total if total is not None else len(raw))
    return "ok"


def ingest_safari(relay: Relay, q: dict[str, str], body: str) -> dict:
    body = body.strip()
    records: list = []
    if body.startswith("["):
        try:
            records = json.loads(body)
        except json.JSONDecodeError:
            records = []
    else:
        for line in body.splitlines():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    records = [r for r in records if isinstance(r, dict)]
    lines = [json.dumps(r, sort_keys=True, ensure_ascii=False) for r in records]
    new, earliest = relay.store.add_lines(lines, "safari", q.get("dev"))
    if earliest is not None:
        devices = relay.devices(datetime.now(timezone.utc))
        if devices:
            relay.mark(devices[0], earliest)
    return {"ok": True, "received": len(records), "new": new}


def supervise(command: str) -> None:
    """Run ActivityWatch's server and restart it if it exits."""
    delay = 1
    while True:
        started = time.time()
        log("starting:", command)
        code = subprocess.call(command, shell=True)
        log(f"ActivityWatch server exited with {code}")
        delay = 1 if time.time() - started > 60 else min(delay * 2, 60)
        time.sleep(delay)


def main(argv=None) -> None:
    key = os.environ.get("TT_KEY")
    if not key or len(key) < 16:
        sys.exit("Set TT_KEY to a random string of at least 16 characters (e.g. `openssl rand -hex 24`).")
    data = os.environ.get("TT_DATA", "data")
    os.makedirs(data, exist_ok=True)
    aw_url = os.environ.get("TT_AW_URL", "http://127.0.0.1:5600")
    aw_api_key = os.environ.get("TT_AW_API_KEY") or None
    if os.environ.get("TT_AW_COMMAND"):
        threading.Thread(target=supervise, args=(os.environ["TT_AW_COMMAND"],), daemon=True).start()

    relay = Relay(Store(os.path.join(data, "tt.db")), awsync.AW(aw_url, aw_api_key))
    threading.Thread(target=relay.run_forever, daemon=True).start()
    relay.wake.set()

    host, port = os.environ.get("TT_HOST", "0.0.0.0"), int(os.environ.get("PORT", os.environ.get("TT_PORT", 8080)))
    ingest_key = os.environ.get("TT_INGEST_KEY") or None
    if ingest_key and len(ingest_key) < 16:
        sys.exit("TT_INGEST_KEY must be at least 16 characters.")
    server = ThreadingHTTPServer((host, port), make_handler(relay, key, aw_url, aw_api_key, ingest_key))
    log(f"tt-relay listening on {host}:{port}, ActivityWatch at {aw_url}, data in {data}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
