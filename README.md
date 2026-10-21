# TimeTrackerOne

Cross-device screen-time tracking built on ActivityWatch: iPhone/iPad (Shortcuts
automations, a companion app, a Safari extension) and desktop watchers, fused
into ActivityWatch buckets by a relay that acts as one more watcher.

Current stage: the pieces are built and being tried out on a real phone.
How it fits together and why: [`docs/architecture-handoff.md`](docs/architecture-handoff.md).
To install everything, follow [`SETUP.md`](SETUP.md); it's written so a local
Claude Code session can do most of it.

- [`server/`](server): the relay. Runs remotely (Fly.io), fuses the phone's
  logs ([`docs/fusion.md`](docs/fusion.md)), and keeps ActivityWatch up to
  date. Also mirrors the desktop's ActivityWatch into the same place.
- [`shortcuts/`](shortcuts): the iPhone shortcuts (the watcher, the open/close
  loggers and TT Sync), written in Cherri and published by CI.
- [`safari-extension/`](safari-extension) and [`ios/`](ios): TT Safari and the
  app that carries it.

- [`docs/empirical-tests.md`](docs/empirical-tests.md): the tests to run on the
  phone, what each one decides, and how to set them up.
- [`test-harness/`](test-harness): webhook receiver, log analyzer, Safari probe
  extension and lock-probe App Intent used by those tests.
