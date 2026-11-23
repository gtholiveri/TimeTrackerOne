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
 TT Watch (loop)      ─┐ app actions           relay (server/ttserver)           ActivityWatch (local)
 open/close automations┤ (never fail)          · stores raw lines (SQLite)  ◀──  window / AFK / Chrome
                       ▼                       · fuses them (fusion.py)          watchers, as usual
 TimeTracker app: queue ───────HTTPS──▶        · writes ActivityWatch buckets       │
   + location, motion                          · /tt/state live feed             mirror.py copies local
 TT Safari (extension) ───────────HTTPS──▶     · ActivityWatch web UI ◀────────  buckets every minute
                                               · pulls WHOOP (whoop.py) ◀── WHOOP API
                                               aw-server-rust (same container)
```

### On the iPhone

**TT Watch** (`shortcuts/tt-watch.cherri`) is a Shortcuts loop. Every ~2.3 s it:
- reads `Device Is Locked` and `Get Current App`;
- logs a line only when either changed, plus a heartbeat every 150 ticks
  (~6 minutes) carrying the battery level;
- hands them to the TimeTracker app (Log TT Lines).

While the phone is locked it writes nothing: lines wait in memory and are
handed to the TimeTracker app (Log TT Lines) right after the unlock, each
with its own timestamp, so the relay hears about
an unlock even when it fires no automation. It loops until iOS stops it.

**Opens and closes** come from two personal automations (any app, Is
Opened / Is Closed, Run Immediately) whose only steps are Get Current App and
the app's Log App Opened / Log App Closed. iOS passes the automation no app
name, so Get Current App is what identifies the app. Locking the phone fires
a close; unlocking fires nothing.

**The TimeTracker app** (`ios/App/`, since 2026-11-21) owns the phone's
network traffic. Its Shortcuts actions (`TTIntents.swift`) append lines to a
queue file in the app's container (`TTLog.swift`, writable while locked after
the first unlock) and try an upload to `/tt/ingest`; a failed upload leaves
the lines queued for the next one. They never throw, so nothing shows an
error banner offline. The app also records, with the app closed
(`TTSensors.swift`, needs Location "Always"):
- `kind=visit` (arrive, depart, lat, lon) and `kind=loc` (a fix every ~500 m);
- `kind=motion` (stationary, walking, running, cycling, automotive), read
  from the motion coprocessor's 7-day history whenever the app runs.
Fusion doesn't use these yet; they're stored raw.

That's the whole phone setup: the app, TT Watch and the two automations. TT
Sync, TT App Opened/Closed, the iCloud log files and the Trial 1/2 test
shortcuts are retired (`test-harness/shortcuts/`).

**Line format:** `tt|src=ios|kind=change|dev=...|ts=...|locked=No|cur=Safari`.
These are key=value pairs, not JSON, because Cherri reads `{...}` in strings as
variables.

**TT Safari** (`safari-extension/`) ships inside the TimeTracker app
(`ios/`), installed through TestFlight (`ios/README.md`). Each page's content script reports:
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

   `TT_KEY` opens everything. `TT_INGEST_KEY` opens the two uploads and the
   reads (logged as `phone`, for the app's data viewer), never writes or the
   web UI, and is the one stored on the phone.

### The desktop

ActivityWatch's normal desktop install runs the window and AFK watchers, plus
the browser extension, against a local server. `ttserver/mirror.py` copies
every local bucket, unchanged, to the relay's ActivityWatch once a minute,
through the relay with `TT_KEY`. It reconciles the same way, so it can stop,
restart or catch up after time offline without duplicating anything. Phone
and laptop then show up as two hosts in one ActivityWatch.

aw-server-rust cuts the events it lists to the query's range, so every read
fetches the events at either end of the range again by id (`AW.events`).
Until 2026-10-27 the mirror didn't, and each pass cut any event crossing the
start of its two-hour window: a not-afk span longer than two hours kept only
its last two, and the dashboard (which counts window time only while not-afk)
lost most of each long working stretch. The mirror's state file has a version;
bumping it makes the next start copy the whole backfill again, which repairs
the relay's copy.

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
| `ios-app.yml` | Builds the unsigned TimeTracker app on a macOS runner with XcodeGen. Publishes `TimeTracker-unsigned.ipa` on the `ios-app` pre-release. Now only a compile check: signed TestFlight builds come from a nomac cloud Mac (`ios/README.md`). |
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
  - the open automation launching it when the relay reports the watcher dead.
    "Run Shortcut" waits for the child to finish, which complicates this.
- **Offline** is handled by the app's queue since 2026-11-21 (not yet
  proven on the phone).
- **Location, motion and WHOOP in fusion.** Stored raw; not used by
  fusion.py or the dashboard yet.
- **Home Screen vs. locked** is a guess wherever the watcher has no data.
- **iPad.** iCloud Drive > Shortcuts is shared across devices on one Apple ID,
  so an iPad would need its own file names.
- **The iOS app needs a paid Apple Developer team** on a separate adult
  Apple ID (the phone's is set as under 18 for Screen Time). Until that
  exists, TT Safari isn't installed. TestFlight builds last 90 days.
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
