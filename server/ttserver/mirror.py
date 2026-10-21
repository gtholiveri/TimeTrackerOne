"""Copy this computer's ActivityWatch buckets to the relay's ActivityWatch.

The desktop watchers (window, AFK, the browser extensions) write to the
ActivityWatch server on this computer, as usual. This copies their buckets,
unchanged, into the relay's ActivityWatch every minute, so the phone and the
computer end up in one place, and the computer's data is there for anything
that reads the relay while the computer is off.

    python -m ttserver.mirror --relay https://<app>.fly.dev --key <TT_KEY>

It only reads from the local server. Each pass makes the relay's copy of the
recent events (since the last pass that worked, and at least the last two
hours) equal to the local ones (awsync.AW.reconcile), so it can be stopped,
restarted or run twice without duplicating anything. The first pass for each
bucket copies its last --backfill-days.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from .awsync import AW, CLIENT

RECENT = timedelta(hours=2)
SLACK = timedelta(minutes=10)


def log(message: str, path: str | None) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}"
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    elif sys.stdout:
        print(line, flush=True)


def mirror_once(local: AW, remote: AW, state: dict, backfill: timedelta, now: datetime | None = None) -> dict:
    """One pass over every local bucket. `state` maps bucket id to the time of
    its last successful pass (ISO), and is updated in place."""
    now = now or datetime.now(timezone.utc)
    results = {}
    for bucket_id, bucket in local.buckets().items():
        if bucket.get("client") == CLIENT:
            continue  # the relay's own phone buckets, if this computer ever ran the relay
        last = state.get(bucket_id)
        since = now - backfill if last is None else min(datetime.fromisoformat(last) - SLACK, now - RECENT)
        remote.ensure_bucket(bucket_id, bucket["type"], bucket.get("hostname") or "unknown",
                             client=bucket.get("client") or "unknown")
        events = local.events(bucket_id, since, now + timedelta(minutes=5))
        desired = [{"timestamp": e["timestamp"], "duration": e["duration"], "data": e["data"]} for e in events]
        results[bucket_id] = remote.reconcile(bucket_id, desired, since, now + timedelta(days=1))
        state[bucket_id] = now.isoformat()
    return results


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--relay", default=os.environ.get("TT_RELAY"), help="https://<app>.fly.dev")
    p.add_argument("--key", default=os.environ.get("TT_KEY"), help="the relay's TT_KEY")
    p.add_argument("--local", default="http://127.0.0.1:5600", help="this computer's ActivityWatch")
    p.add_argument("--interval", type=float, default=60, help="seconds between passes")
    p.add_argument("--backfill-days", type=float, default=30)
    p.add_argument("--state", default=os.path.join(os.path.expanduser("~"), ".tt-mirror.json"))
    p.add_argument("--log", default=None, help="append to this file instead of printing")
    p.add_argument("--once", action="store_true", help="one pass, then exit")
    args = p.parse_args(argv)
    if not args.relay or not args.key:
        p.error("--relay and --key are required")

    local = AW(args.local, timeout=30)
    remote = AW(args.relay, api_key=args.key, timeout=60)
    try:
        with open(args.state, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    backfill = timedelta(days=args.backfill_days)
    log(f"mirroring {args.local} to {args.relay} every {args.interval:g} s", args.log)
    while True:
        try:
            results = mirror_once(local, remote, state, backfill)
            with open(args.state, "w", encoding="utf-8") as f:
                json.dump(state, f)
            changed = {b: r for b, r in results.items() if r != (0, 0)}
            if changed:
                log("copied (inserted, deleted): " + json.dumps(changed), args.log)
        except Exception as e:  # ActivityWatch not running yet, or no network: try again later
            log(f"pass failed: {type(e).__name__}: {e}", args.log)
            if args.once:
                sys.exit(1)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
