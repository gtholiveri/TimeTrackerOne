"""Parse the raw log lines the phone and the Safari extension send.

Shortcuts can't build JSON easily (Cherri reads `{...}` as variables), so the
phone writes `tt|key=value|key=value` lines:

    tt|src=ios|kind=open|dev=Gabe's iPhone|ts=2026-10-21 14:03:22.123-07:00|input=Safari|cur=Safari

The Safari extension sends JSON objects, one per line. Both parse to a plain
dict; to_record() turns a phone line into a fusion.Record.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from .fusion import Record

CURLY_QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})
_KEY = re.compile(r"^[a-z][a-z0-9_.]*$")


def parse_line(line: str) -> dict | None:
    line = line.strip().lstrip("﻿")
    if not line:
        return None
    if line.startswith("tt|"):
        out: dict[str, str] = {}
        last = None
        for part in line[3:].split("|"):
            key, eq, value = part.partition("=")
            if eq and _KEY.match(key):
                out[key] = value
                last = key
            elif last is not None:
                # A value that itself contained "|" (e.g. an app or page name).
                out[last] += "|" + part
        return out or None
    if "{" in line:
        body = line[line.find("{"):]
        for candidate in (body, body.translate(CURLY_QUOTES)):
            try:
                d = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            return d if isinstance(d, dict) else None
    return None


def parse_ts(value) -> datetime | None:
    """Timestamps from Shortcuts ("2026-10-21 14:03:22.123-07:00") or JS
    (ISO 8601 with Z), as aware datetimes. Naive ones are taken as UTC."""
    if not value or not isinstance(value, str):
        return None
    try:
        ts = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def to_record(d: dict) -> Record | None:
    ts = parse_ts(d.get("ts"))
    kind = d.get("kind")
    if ts is None or not kind:
        return None
    return Record(
        ts=ts,
        kind=kind,
        dev=d.get("dev") or "iphone",
        locked=d.get("locked"),
        cur=d.get("cur"),
        input=d.get("input"),
        run=d.get("run"),
    )
