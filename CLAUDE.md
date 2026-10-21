# Notes for Claude

Screen-time tracking across iPhone and desktop, built on ActivityWatch.
README.md has the map; this is what an agent working here needs on top.

- **Setting things up on Gabe's laptop:** follow `SETUP.md`.
- **Secrets:** the relay keys live in `C:\Users\gabeo\tt-relay-keys.txt` and
  in Fly secrets. Never write them into the repo, a commit, or a shortcut
  source. The repo and its releases are public. TT Sync gets its URL from an
  import question for this reason.
- **Real usage logs stay out of the repo** (`logs/` is ignored). Tests use
  synthetic data.
- **Shortcuts** are Cherri sources in `shortcuts/`. CI compiles and signs them
  and publishes them on the `shortcuts` release; never edit `.shortcut` files.
  The quirks are in `shortcuts/README.md`.
- **Relay** (`server/`): stdlib-only Python. Tests:
  `cd server; python -m unittest discover -s tests`. The end-to-end tests need
  `AW_SERVER` pointing at an aw-server-rust binary. Deploy changes with
  `fly deploy` from `server/`.
- **Fusion rules** and their evidence: `docs/fusion.md`. Phone test results:
  `docs/findings.md`.
- **Commits:** push to `main`. Keep Gabe as the author.
