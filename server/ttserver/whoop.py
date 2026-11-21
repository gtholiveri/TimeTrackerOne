"""WHOOP: pulls everything the WHOOP API offers into the relay's database.

Cycles (strain, kilojoules, heart rate per physiological day), recoveries
(recovery score, HRV, resting heart rate, SpO2, skin temperature), sleeps
(stages, performance, respiratory rate, need) and workouts (sport, strain,
heart-rate zones, distance), plus the profile and body measurements. Each
record is kept whole, as WHOOP's JSON, keyed by kind and id, and replaced
when WHOOP updates it (scores arrive minutes to hours after the event).

Setup (server/README.md, "WHOOP"): register an app at
https://developer-dashboard.whoop.com with the redirect URL
https://<relay>/tt/whoop/callback, set TT_WHOOP_CLIENT_ID and
TT_WHOOP_CLIENT_SECRET, then open https://<relay>/tt/whoop/connect?key=TT_KEY
once and sign in to WHOOP. The relay keeps the refresh token (WHOOP rotates it
on every refresh) and syncs every SYNC_EVERY seconds from then on. The first
sync backfills everything since BACKFILL_FROM.

Only the standard library, like the rest of the relay.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API = "https://api.prod.whoop.com/developer"
SCOPES = "offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout"

# kind -> collection path. Recoveries are keyed by their cycle.
COLLECTIONS = {
    "cycle": "/v2/cycle",
    "recovery": "/v2/recovery",
    "sleep": "/v2/activity/sleep",
    "workout": "/v2/activity/workout",
}
SINGLES = {"profile": "/v2/user/profile/basic", "body": "/v2/user/measurement/body"}

SYNC_EVERY = 15 * 60
OVERLAP = timedelta(days=3)  # re-read the last few days: scores and edits land late
BACKFILL_FROM = datetime(2015, 1, 1, tzinfo=timezone.utc)
PAGE = 25  # WHOOP's maximum

SCHEMA = """
CREATE TABLE IF NOT EXISTS whoop (
    kind TEXT NOT NULL,          -- cycle, recovery, sleep, workout, profile, body
    id TEXT NOT NULL,
    start TEXT,                  -- UTC ISO 8601 as WHOOP gives it; NULL for profile/body
    end TEXT,
    updated TEXT,                -- WHOOP's updated_at
    json TEXT NOT NULL,
    fetched REAL NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS whoop_by_time ON whoop (kind, start);
CREATE TABLE IF NOT EXISTS whoop_auth (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    refresh_token TEXT NOT NULL,
    access_token TEXT,
    expires REAL
);
"""


def record_id(kind: str, r: dict) -> str:
    if kind == "recovery":
        return str(r.get("cycle_id"))
    return str(r.get("id"))


class Whoop:
    def __init__(self, path: str, client_id: str, client_secret: str, state_key: str, log=print,
                 opener=urllib.request.urlopen):
        self.client_id, self.client_secret = client_id, client_secret
        self.state_key = state_key.encode()
        self.log = log
        self.open = opener  # tests swap in a fake WHOOP
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()
        self.sync_lock = threading.Lock()
        self.wake = threading.Event()
        self.last_sync: float | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------ OAuth

    def state(self) -> str:
        """A state value only this relay can make, so the callback needs no key."""
        nonce = secrets.token_urlsafe(12)
        return nonce + "." + hmac.new(self.state_key, nonce.encode(), hashlib.sha256).hexdigest()[:24]

    def state_ok(self, state: str) -> bool:
        nonce, _, mac = state.partition(".")
        good = hmac.new(self.state_key, nonce.encode(), hashlib.sha256).hexdigest()[:24]
        return bool(nonce) and hmac.compare_digest(mac.encode(), good.encode())

    def auth_url(self, redirect_uri: str) -> str:
        return AUTH_URL + "?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": self.client_id, "redirect_uri": redirect_uri,
            "scope": SCOPES, "state": self.state()})

    def connect(self, code: str, redirect_uri: str) -> None:
        tokens = self._token({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
        self._save(tokens)
        self.wake.set()

    @property
    def connected(self) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM whoop_auth").fetchone() is not None

    def _token(self, form: dict) -> dict:
        form = {**form, "client_id": self.client_id, "client_secret": self.client_secret}
        req = urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(form).encode(), method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.open(req, timeout=30) as res:
            return json.loads(res.read())

    def _save(self, tokens: dict) -> None:
        expires = time.time() + float(tokens.get("expires_in", 3600)) - 120
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO whoop_auth (one, refresh_token, access_token, expires) VALUES (1, ?, ?, ?) "
                "ON CONFLICT (one) DO UPDATE SET refresh_token = excluded.refresh_token, "
                "access_token = excluded.access_token, expires = excluded.expires",
                (tokens["refresh_token"], tokens["access_token"], expires))

    def _access_token(self) -> str:
        with self.lock:
            row = self.db.execute("SELECT refresh_token, access_token, expires FROM whoop_auth").fetchone()
        if row is None:
            raise RuntimeError("WHOOP not connected: open /tt/whoop/connect")
        refresh, access, expires = row
        if access and expires and time.time() < expires:
            return access
        tokens = self._token({"grant_type": "refresh_token", "refresh_token": refresh, "scope": "offline"})
        self._save(tokens)
        return tokens["access_token"]

    # ------------------------------------------------------------ API

    def _get(self, path: str, params: dict | None = None) -> dict:
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in range(5):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._access_token()}"})
            try:
                with self.open(req, timeout=30) as res:
                    return json.loads(res.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 4:  # rate limited: back off and retry
                    time.sleep(float(e.headers.get("Retry-After") or 10 * (attempt + 1)))
                    continue
                if e.code == 401 and attempt < 4:  # token revoked early: force a refresh
                    with self.lock, self.db:
                        self.db.execute("UPDATE whoop_auth SET expires = 0")
                    continue
                raise
        raise RuntimeError("unreachable")

    def _store(self, kind: str, records: list[dict]) -> int:
        now = time.time()
        changed = 0
        with self.lock, self.db:
            for r in records:
                cur = self.db.execute(
                    "INSERT INTO whoop (kind, id, start, end, updated, json, fetched) VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT (kind, id) DO UPDATE SET start = excluded.start, end = excluded.end, "
                    "updated = excluded.updated, json = excluded.json, fetched = excluded.fetched "
                    "WHERE whoop.json != excluded.json",
                    (kind, record_id(kind, r), r.get("start") or r.get("created_at"), r.get("end"),
                     r.get("updated_at"), json.dumps(r, sort_keys=True), now))
                changed += cur.rowcount
        return changed

    def _newest(self, kind: str) -> datetime | None:
        with self.lock:
            row = self.db.execute("SELECT MAX(start) FROM whoop WHERE kind = ?", (kind,)).fetchone()
        if not row or not row[0]:
            return None
        return datetime.fromisoformat(row[0].replace("Z", "+00:00"))

    def sync(self) -> dict[str, int]:
        """Fetch everything new or changed. Returns records changed per kind."""
        with self.sync_lock:
            out: dict[str, int] = {}
            for kind, path in SINGLES.items():
                r = self._get(path)
                r.setdefault("id", kind)
                out[kind] = self._store(kind, [r])
            for kind, path in COLLECTIONS.items():
                newest = self._newest(kind)
                start = (newest - OVERLAP) if newest else BACKFILL_FROM
                params = {"limit": PAGE, "start": start.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
                changed = 0
                while True:
                    page = self._get(path, params)
                    changed += self._store(kind, page.get("records") or [])
                    token = page.get("next_token") or page.get("nextToken")
                    if not token:
                        break
                    params["nextToken"] = token
                out[kind] = changed
            self.last_sync = time.time()
            return out

    def run_forever(self) -> None:
        while True:
            if self.connected:
                try:
                    changed = self.sync()
                    self.last_error = None
                    if any(changed.values()):
                        self.log("whoop:", ", ".join(f"{k} {n}" for k, n in changed.items() if n))
                except Exception as e:
                    self.last_error = f"{type(e).__name__}: {e}"
                    self.log("whoop sync failed:", self.last_error)
            self.wake.wait(SYNC_EVERY)
            self.wake.clear()

    # ------------------------------------------------------------ reading

    def records(self, kind: str | None, since: datetime | None) -> list[dict]:
        q, args = "SELECT kind, json FROM whoop WHERE 1 = 1", []
        if kind:
            q += " AND kind = ?"
            args.append(kind)
        if since is not None:
            q += " AND (start IS NULL OR start >= ?)"
            args.append(since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"))
        with self.lock:
            rows = self.db.execute(q + " ORDER BY start", args).fetchall()
        return [{"kind": k, **json.loads(j)} for k, j in rows]

    def status(self) -> dict:
        with self.lock:
            counts = dict(self.db.execute("SELECT kind, COUNT(*) FROM whoop GROUP BY kind").fetchall())
        return {"connected": self.connected, "last_sync": self.last_sync, "error": self.last_error,
                "records": counts}
