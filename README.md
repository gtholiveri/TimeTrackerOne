# TimeTrackerOne

Cross-device screen-time tracking built on ActivityWatch: iPhone/iPad (Shortcuts
automations, a companion app, a Safari extension) and desktop watchers, fused
into ActivityWatch buckets by a relay that acts as one more watcher.

Current stage: measuring iOS behaviour before building the iOS side.

- [`docs/empirical-tests.md`](docs/empirical-tests.md): the tests to run on the
  phone, what each one decides, and how to set them up.
- [`test-harness/`](test-harness): webhook receiver, log analyzer, Safari probe
  extension and lock-probe App Intent used by those tests.
