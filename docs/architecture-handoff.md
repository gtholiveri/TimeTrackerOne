# Architecture and handoff

Everything someone picking this project up needs: what it is for, how the
pieces fit, why each decision went the way it did, what has been proven on the
real phone, and what is still open. Details live in the linked docs; this page
is the map plus the reasoning.

## What it's for

One timeline of what Gabe is doing on every screen: iPhone (and later the
iPad) and the desktop, with the app, the web page, and whether the device is
in use. It must be accurate to seconds and as live as possible. The uses:

- understanding productivity, and cutting distractions;
- later, a live feed an AI agent can react to, to keep him on track. Don't
  design for the agent yet; just keep the live feed (`/tt/state`) good.

What doesn't matter much:
- rapid app switching;
- Control Center and Notification Center;
- Home Screen time;
- whether idle-but-unlocked time is counted.

Picture-in-picture and background audio are fine counted as the app in front.

**ActivityWatch's data model is the format.** Everything ends up as
ActivityWatch buckets and events. ActivityWatch has no watcher base class: a
watcher is any process that creates its buckets and posts events over the
REST API. Our relay is one more watcher, for the phone.

## The pieces

```
 iPhone                                        Fly.io (always on)                Laptop
 ──────                                        ──────────────────                ──────
 TT Watch (loop)      ─┐  log files in         relay (server/ttserver)           ActivityWatch (local)
 TT App Opened/Closed ─┤  iCloud Drive >  ──▶  · stores raw lines (SQLite)  ◀──  window / AFK / Chrome
 (personal automations)│  Shortcuts            · fuses them (fusion.py)          watchers, as usual
                       └─ TT Sync  ──HTTPS──▶  · writes ActivityWatch buckets       │
 TT Safari (extension) ───────────HTTPS──▶     · /tt/state live feed             mirror.py copies local
                                               · ActivityWatch web UI ◀────────  buckets every minute
                                               aw-server-rust (same container)
```

### On the iPhone

**TT Watch** (`shortcuts/tt-watch.cherri`) is a Shortcuts loop. Every ~2.3 s it:
- reads `Device Is Locked` and `Get Current App`;
- logs a line only when either changed, plus a heartbeat every 150 ticks
  (~6 minutes) carrying the battery level;
- writes to `tt-watch-<date>.txt` in iCloud Drive > Shortcuts.

While the phone is locked it writes nothing: lines wait in memory and are
written right after the unlock, each with its own timestamp. After writing a
locked stretch it uploads its file itself, because unlocking straight back
into the same app fires no automation. It doesn't run TT Sync for this: both
runs that died on its first day died at an unlock where an automation's TT
Sync ran in the same second (`findings.md`). It only uploads with a Wi-Fi
network or some signal, since a failed request would stop the loop. It
loops until iOS stops it.

**TT App Opened / TT App Closed** are run by two personal automations (any
app, Is Opened / Is Closed, Run Immediately). Each:
- appends one line to `tt-events-<date>.txt`, with the app the automation
  passed in;
- then runs TT Sync.

Locking the phone fires a close; unlocking fires nothing.

**TT Sync** uploads, for each of today's two files, the last 20 lines plus the
file's line count. The relay answers `full` if it is missing earlier lines
(first sync of the day, or after time offline), and TT Sync then sends the
whole file. Duplicates are harmless; the relay drops them. The relay URL and
key come from an import question, answered when the shortcut is added.

**Line format:** `tt|src=ios|kind=change|dev=...|ts=...|locked=No|cur=Safari`.
These are key=value pairs, not JSON, because Cherri reads `{...}` in strings as
variables.

**TT Safari** (`safari-extension/`) ships inside the sideloaded TimeTracker app
(`ios/`). Each page's content script reports:
- visible and hidden;
- URL changes (single-page apps included);
- title changes;
- a beat every 15 s while visible.

It posts these straight to the relay's `/tt/safari`. The background script is
only a fallback queue.

### The relay (`server/`, deployed on Fly.io)

Stdlib-only Python plus ActivityWatch's own server (aw-server-rust 0.13.2,
from the official release) in one Docker image. The relay starts that server
and restarts it if it exits. In order:

1. **Store.** Every raw line goes into SQLite, deduplicated by content. The raw
   lines are the source of truth; everything else is derived and can be
   rebuilt.
2. **Fuse** (`fusion.py`, explained in [`fusion.md`](fusion.md)):
   - The watcher gives the state to within a tick, and each of its
     transitions is moved to the automation event that caused it.
   - Where the watcher has no data, the automations' own timeline fills in.
     After a close, Home Screen if the next open came within 20 s, locked
     otherwise.
   - The newest state runs to now, marked provisional.
   - Every interval carries a confidence label.
3. **Write to ActivityWatch** (`awsync.py`). The buckets are:
   - `aw-watcher-window_<phone>`, with the app, and the page title for Safari;
   - `aw-watcher-afk_<phone>`, locked or not;
   - `aw-watcher-web-safari_<phone>`.

   Late lines change recent history: a locked stretch arrives after the unlock,
   and the live tail keeps moving. So each pass reconciles the recent events,
   deleting what is no longer right and inserting what is missing, rather than
   appending. That runs after every upload and every 20 s.
4. **Serve:**
   - `/tt/ingest` and `/tt/safari`: uploads.
   - `/tt/state`: the fused timeline and current state per device.
   - `/tt/lines`: raw lines, for debugging.
   - `/tt/health`.
   - Everything else: the ActivityWatch web UI and API, behind HTTP basic
     auth.

   `TT_KEY` opens everything. `TT_INGEST_KEY` only opens the two uploads, and
   is the one stored on the phone.

### The desktop

ActivityWatch's normal desktop install runs the window and AFK watchers, plus
the browser extension, against a local server. `ttserver/mirror.py` copies
every local bucket, unchanged, to the relay's ActivityWatch once a minute,
through the relay with `TT_KEY`. It reconciles the same way, so it can stop,
restart or catch up after time offline without duplicating anything. Phone
and laptop then show up as two hosts in one ActivityWatch.

### The dashboard

`server/dashboard` is a React app the relay serves at `/app/`, behind the same
key. It only reads ActivityWatch (the same API its web UI uses) and the live
feed, and writes two settings: `classes` (ActivityWatch's own categories, with
`score` as the productive / neutral / distracting rating) and `tt_attention`
(the merge rules below). Tabs: Today (glance, phone-friendly), Explore
(filters and plots), Categories (rule editor with live preview, uncategorized
triage), Attention (the merge rules, with a preview).

The merged "you" line picks, moment by moment, the device that had your
attention. The phone has no idle signal, so being unlocked isn't enough: apps
on a background list (Clock, Spotify, Music, Podcasts, Maps by default) never
count; otherwise the phone wins over an active laptop (configurable); the
Home Screen counts only when nothing else does. These are first rules, meant
to be refined (duration-based ones, say) as real days show where they're wrong.

### Build and release (CI)

| Workflow | What it does |
| --- | --- |
| `shortcuts.yml` | Compiles the Cherri sources and signs them through RoutineHub's HubSign service (iOS only imports signed shortcuts). Publishes them on the `shortcuts` pre-release, so each one is a one-tap install link. |
| `ios-app.yml` | Builds the unsigned TimeTracker app on a macOS runner with XcodeGen. Publishes `TimeTracker-unsigned.ipa` on the `ios-app` pre-release, for Sideloadly. |
| `server.yml` | Unit tests, end-to-end tests against the released aw-server-rust, the dashboard's tests, and a Docker build (dashboard included) and smoke test. |

## Why it's built this way

- **Shortcuts are written as code.** Gabe can't stand the Shortcuts block
  editor. Cherri compiles text into shortcuts, and CI signs and publishes
  them.
  - Action identifiers for things Cherri lacks come from a shortcut built
    once on the phone, read through the iCloud record API.
  - `--derive-uuids` and capturing every file write's output keep action IDs
    stable, and iOS seems to remember "Always Allow" per action ID.
- **The phone writes locally first and syncs separately**, so a network
  failure can't lose data: the files are the phone's copy.
- **Is Locked is buffered while locked.** Writing a file while locked, in a
  loop that also reads Is Locked, made iOS stop the loop with a permission
  prompt (TT Lock Direct). Reading Is Locked while locked and writing only
  after the unlock works: Trial 2 and TT Lock Watch.
- **Two streams, not one.** `Get Current App` keeps reporting the last app
  while locked, so polling it alone can't see the phone lock. Automations
  can't see an unlock. The watcher gives the state, and the automations give
  exact transition times.
- **The relay reconciles instead of appending.** History before the newest
  line legitimately changes as late lines arrive.
- **Tail uploads instead of whole files** keep mobile data small. Each sync
  sends a few KB instead of the whole day's files on every app switch.
- **Fly.io, not Vercel.** ActivityWatch's server needs an always-on process
  and a disk. Vercel only runs code per request and keeps nothing between
  requests. Gabe chose Fly.
- **The desktop keeps its local ActivityWatch and mirrors it**, rather than
  pointing the watchers at the relay. Local tracking keeps working offline,
  and ActivityWatch's watchers can't send a key.
- **TT Safari sends from the page.** iOS Safari suspends extension background
  scripts aggressively. The content script is the part known to keep
  running.
- **No canaries or alerting.** Gabe explicitly doesn't want them.
- **HubSign is used only through Cherri itself.** It only signs for Cherri's
  user agent, and we don't spoof that.

## Proven on the phone, and not yet

From [`findings.md`](findings.md), where the trials are written up:

**Proven:**
- `Get Current App` returns the app's name, and an empty string on the Home
  Screen and in the app switcher.
- Automation closes fire reliably, even on a straight power-off.
- The buffered Is Locked loop survives locks: 4 minutes in Trial 2, then 7 and
  18 minutes in TT Lock Watch. It catches the unlock within one tick, and runs
  at 2.3 s per tick locked or not.
- It catches unlocks straight back into the same app.

**Built but not yet run on the phone:**
- TT Sync, including calling it by name from the other shortcuts. Cherri
  writes the "Run Shortcut" action with the name only. The first try on the
  phone failed on exactly that: iOS names an imported shortcut after its file,
  so it arrived as "TT-Sync" while the calls said "TT Sync". The calls now use
  "TT-Sync"; not yet rerun.
- The automations calling TT Sync while the phone locks.
- TT Safari on iOS.

Running since 2026-10-21: the relay on Fly (`tt-relay-gabe`), the desktop
mirror on Gabe's laptop (both `server/deploy/*.ps1` scripts worked as
written), and the dashboard.

## Open questions and known limits

- **How TT Watch gets restarted.** No time limit showed on its first day (one
  run lasted at least 1 h 51 min); the deaths matched TT Sync collisions,
  which TT Watch no longer risks. Restart ideas, none tried:
  - time-of-day, wake-up and charger automations; first test what starting
    TT Watch does while one is already running;
  - TT App Opened launching it when the relay reports the watcher dead.
    "Run Shortcut" waits for the child to finish, which complicates this.
- **Offline.** TT Sync errors without network, and so does whatever ran it,
  so the automations show error banners offline. TT Watch skips its upload
  without Wi-Fi or signal and keeps going (Wi-Fi without internet still stops
  it). Nothing is lost.
- **Home Screen vs. locked** is a guess wherever the watcher has no data.
- **iPad.** iCloud Drive > Shortcuts is shared across devices on one Apple ID,
  so an iPad would need its own file names.
- **The sideloaded app expires** after 7 days with a free Apple ID.
- **Permission prompts.** "Always Allow" mostly sticks, but some prompts come
  back at odd moments. It settled down after the first approvals.

## Working with Gabe

- **Explain fully.** Write step-by-step instructions that don't assume he
  remembers earlier context. Over-compressed answers have been a problem.
- **Prefer code to manual phone fiddling.** Generate shortcuts; give one-tap
  links. He tests empirically on his own iPhone and emails himself the log
  files.
- **The repo is public.** No secrets, no real usage logs. Tests use synthetic
  data. Commit and push to `main`, with Gabe as the author.

## Where things are

| Path | What |
| --- | --- |
| `SETUP.md` | Installing everything, step by step, with checks |
| `docs/fusion.md` | The fusion rules, error bounds and limits |
| `docs/findings.md` | What the phone trials showed |
| `docs/empirical-tests.md` | The test plan (T1–T12) and the iOS app install |
| `shortcuts/` | Cherri sources, plus the README with install links and Cherri quirks |
| `server/ttserver/` | `app.py` (HTTP, loop), `fusion.py`, `web.py` (Safari pages), `awsync.py` (ActivityWatch client and reconcile), `store.py`, `lines.py`, `mirror.py` |
| `server/README.md` | Endpoints, deploying, the desktop mirror, the dashboard, tests |
| `server/dashboard/src/lib/` | The dashboard's data layer: `activity.ts` (buckets to per-device activity), `categories.ts`, `attention.ts` (the merge rules), `aggregate.ts` |
| `safari-extension/`, `ios/` | TT Safari and the app that carries it |
| `test-harness/` | The early receiver, log analyzer and probes from the trials |
