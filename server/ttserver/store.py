"""SQLite store for every raw line the server receives.

The raw lines are the source of truth: fusion runs over them again whenever
new ones arrive, and ActivityWatch only ever holds the derived events. The
phone re-sends lines freely (TT Sync uploads the tail of each file, and the
whole file when the server asks), so lines are deduplicated by content.
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from datetime import datetime, timezone

from .lines import parse_line, parse_ts

SCHEMA = """
CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,        -- 'ios' (Shortcuts) or 'safari' (the extension)
    dev TEXT,                    -- device name as the line reports it
    ts TEXT,                     -- the line's own timestamp, UTC ISO 8601; NULL if unreadable
    raw TEXT NOT NULL,
    received REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_by_time ON lines (source, ts);
CREATE INDEX IF NOT EXISTS lines_by_dev ON lines (source, dev);

-- How many lines of each phone file the server has, for TT Sync's tail uploads.
CREATE TABLE IF NOT EXISTS files (
    dev TEXT NOT NULL,
    name TEXT NOT NULL,
    known INTEGER NOT NULL,
    updated REAL NOT NULL,
    PRIMARY KEY (dev, name)
);
"""


# What iOS tells an app the phone is called. Only Shortcuts sees the real name,
# so the TimeTracker app tags lines "iPhone" until TT Watch hands it the name.
GENERIC_DEVICES = ("iPhone", "iPad")


def iso_utc(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat(timespec="microseconds")


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    def add_lines(self, raw_lines: list[str], source: str, dev: str | None = None) -> tuple[int, datetime | None]:
        """Store the lines not seen before. Returns how many were new and the
        earliest timestamp among them (what fusion has to redo from)."""
        new = 0
        earliest = None
        now = time.time()
        real = self.real_device() if source == "ios" else None
        with self.lock, self.db:
            for raw in raw_lines:
                raw = raw.strip()
                d = parse_line(raw)
                if d is None:
                    continue
                ts = parse_ts(d.get("ts"))
                # Hash the line as sent, so a resend stays a duplicate after renaming.
                h = hashlib.sha256(f"{source}\n{raw}".encode()).hexdigest()
                line_dev = d.get("dev") or dev
                if real and line_dev in GENERIC_DEVICES:
                    raw = raw.replace(f"|dev={line_dev}|", f"|dev={real}|", 1)
                    line_dev = real
                cur = self.db.execute(
                    "INSERT OR IGNORE INTO lines (hash, source, dev, ts, raw, received) VALUES (?, ?, ?, ?, ?, ?)",
                    (h, source, line_dev, iso_utc(ts) if ts else None, raw, now))
                if cur.rowcount:
                    new += 1
                    if ts and (earliest is None or ts < earliest):
                        earliest = ts
        return new, earliest

    def real_device(self) -> str | None:
        """The newest phone name that isn't iOS's generic one."""
        for dev, _ in self.devices("ios"):
            if dev not in GENERIC_DEVICES:
                return dev
        return None

    def adopt_generic(self) -> tuple[str, datetime] | None:
        """Give lines tagged with a generic name ("iPhone") the phone's real name,
        once one is known. Returns (name, earliest renamed line) if any changed."""
        real = self.real_device()
        if real is None:
            return None
        with self.lock, self.db:
            rows = self.db.execute(
                "SELECT id, dev, raw, ts FROM lines WHERE source = 'ios' AND dev IN (%s)"
                % ",".join("?" * len(GENERIC_DEVICES)), GENERIC_DEVICES).fetchall()
            for id_, dev, raw, _ in rows:
                self.db.execute("UPDATE lines SET dev = ?, raw = ? WHERE id = ?",
                                (real, raw.replace(f"|dev={dev}|", f"|dev={real}|", 1), id_))
        stamps = [r[3] for r in rows if r[3]]
        if not stamps:
            return None
        return real, datetime.fromisoformat(min(stamps))

    def lines(self, source: str, since: datetime, dev: str | None = None) -> list[tuple[str | None, dict]]:
        """(device, parsed line) for every line of `source` at or after `since`, oldest first."""
        q = "SELECT dev, raw FROM lines WHERE source = ? AND ts >= ?"
        args: list = [source, iso_utc(since)]
        if dev is not None:
            q += " AND dev = ?"
            args.append(dev)
        with self.lock:
            rows = self.db.execute(q + " ORDER BY ts", args).fetchall()
        out = []
        for d, raw in rows:
            parsed = parse_line(raw)
            if parsed is not None:
                out.append((d, parsed))
        return out

    def rows(self, source: str, since: datetime) -> list[tuple[str | None, str, str, float]]:
        """(device, UTC ts, raw line, received epoch) for each line since `since`, oldest first."""
        with self.lock:
            return self.db.execute("SELECT dev, ts, raw, received FROM lines WHERE source = ? AND ts >= ? "
                                   "ORDER BY ts", (source, iso_utc(since))).fetchall()

    def raw(self, source: str, since: datetime) -> list[str]:
        with self.lock:
            rows = self.db.execute("SELECT raw FROM lines WHERE source = ? AND ts >= ? ORDER BY ts",
                                   (source, iso_utc(since))).fetchall()
        return [r[0] for r in rows]

    def devices(self, source: str = "ios") -> list[tuple[str, str]]:
        """(device, newest line timestamp) for each device, most recent first."""
        with self.lock:
            return self.db.execute(
                "SELECT dev, MAX(ts) FROM lines WHERE source = ? AND dev IS NOT NULL AND ts IS NOT NULL "
                "GROUP BY dev ORDER BY MAX(ts) DESC", (source,)).fetchall()

    def last_received(self, source: str, dev: str | None = None) -> float | None:
        q, args = "SELECT MAX(received) FROM lines WHERE source = ?", [source]
        if dev is not None:
            q += " AND dev = ?"
            args.append(dev)
        with self.lock:
            return self.db.execute(q, args).fetchone()[0]

    # ------------------------------------------------------------ file cursors

    def known(self, dev: str, name: str) -> int:
        with self.lock:
            row = self.db.execute("SELECT known FROM files WHERE dev = ? AND name = ?", (dev, name)).fetchone()
        return row[0] if row else 0

    def set_known(self, dev: str, name: str, known: int) -> None:
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO files (dev, name, known, updated) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (dev, name) DO UPDATE SET known = excluded.known, updated = excluded.updated",
                (dev, name, known, time.time()))
