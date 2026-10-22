# Findings so far

Where the iOS tests stand, so work can pick up from here. Test numbers refer to
[`empirical-tests.md`](empirical-tests.md).

## T1, run 1 (2026-09-30): what `Get Current App` reports

Polling loop: Wait ≈3 s (≈3.5 s per tick), started by hand from Shortcuts,
logged to `tt-log.json` with `Append to Text File`.

| State | `Get Current App` |
| --- | --- |
| In an app (Shortcuts, Gmail, Voicenotes, Camera) | Exact app name. Each switch shows up within one tick. |
| Home Screen | Empty string |
| App switcher, even centered on an app | Empty string |
| Screen off; Lock Screen (locked, with Control Center, after Face ID but before swiping up) | **The last app** (Camera), the whole time |

- The loop ran 3 min 15 s with all 56 ticks present and no gaps, including
  about 70 s with the screen off or locked. It was stopped by hand, not killed.
- **Appending to the file while locked worked:** 22 lines were written during
  the locked part, with no problems reported.
- Conclusion: app identity and Home Screen are reliable. Locked and "in the last
  app" look identical, so polling this action alone can't see an unlock straight
  back into the same app.

## T1b (reported, log not analyzed)

- **`Get Visible Apps`:** same as `Get Current App`. It keeps reporting the last
  app while locked.
- **`Get Device Details` → Is Locked:** reports lock state directly. When it
  runs while locked, iOS shows a banner about doing things without privacy
  permissions, and the loop runs into problems.
- **The first locked poll(s) get through:** `"lock-state":"Yes"` was written once
  or twice after locking, before it started failing. So the edge into "locked"
  may be catchable.
- **Close automations are reliable:** the app-closed automation fires reliably,
  even on a straight power-off.

## Shortcuts are now generated from code (2026-10-21)

The test shortcuts are Cherri sources in [`shortcuts/`](../shortcuts), signed by
CI and published on the `shortcuts` pre-release: open a link on the iPhone to
install. The action identifiers come from TT Poll (shared via iCloud):
`getdevicedetails` with `Device Is Locked` / `Current Brightness`, and
`getcurrentapp` with `Current` / `Visible`.

**New hypothesis:** the folder may matter more than Is Locked. T1 run 1, which
wrote fine while locked, wrote to iCloud Drive > Shortcuts. The failing
Is Locked run wrote to On My iPhone > UniversalTimeTracker, and files stored on
the device itself may be unwritable while the phone is locked. The three new
shortcuts all write to iCloud Drive > Shortcuts:
- **TT Brightness:** brightness only, no Is Locked.
- **TT Lock Direct:** Is Locked written every tick, like TT Poll but in the
  other folder.
- **TT Lock Buffer:** Is Locked polled, nothing written while locked.

## Trial 1 (2026-10-21): brightness, and Is Locked while writing

Short locks (5–10 s per step).
- **TT Brightness:** the loop kept writing through the lock (no Is Locked).
  Brightness went 0.45 in an app, 0.3 with the screen off, 0.55 on the Lock
  Screen. It never reads 0, so it can't detect the screen being off.
- **TT Lock Direct:** five `locked=Yes` lines over about 10 s, then the loop
  stopped at a permission prompt. It wrote to iCloud Drive, so **the folder
  isn't the cause**: writing a file while locked with Is Locked in play is.
- **TT Lock Buffer:** survived its short lock and read `No` about 2 s after
  unlocking. Two bugs in the generated shortcuts showed up: the buffer was
  written as a list (iOS asked "Choose an item" and kept one line), and the
  file-write actions had no UUID (permission prompts every run). Both fixed.

## Trial 2 (2026-10-21): the Lock Buffer recipe works

Run 700434: **locked for 4 minutes, with 109 locked ticks in a row and none
missing**, one every 2.28 s (max 2.34 s). The first `locked=No` came **2.3 s
after the last `Yes`**: the unlock was seen within one tick. Quick lock/unlock
cycles (run 684530) were caught too.

- Permission prompts showed up as 7–9 s stalls: one early, and one on the first
  write after the long lock. The following run had no stalls, so the grants
  seem to stick now.
- `cur` keeps reporting the last app while locked, as in T1.
- Brightness: 0.25 the whole time the screen was off, 0.45 in use.

**Recipe:** poll Device Is Locked every ~2 s, keep lines in memory while
locked, and write only once it reads No. Never write a file while locked.

Next: **TT Lock Watch** runs this for an hour, logging only changes plus a
heartbeat every ~6 minutes. That keeps memory use flat during long locks
(Trial 2 held about 16 KB of locked lines) and measures how long iOS lets the
loop run, and the battery cost.

## TT Lock Watch (2026-10-21): the recipe holds for most of an hour

Run 772864, started 13:43, still going at 14:31 when the log was sent: 1237
ticks in 47.9 minutes. That's 2.325 s per tick on average, the same locked
(2.27–2.31 s) as unlocked (2.33–2.35 s). iOS didn't slow the loop down while
locked.

- **Long locks survive:** 6.8 minutes and 18.1 minutes locked. The heartbeats
  during the 18-minute lock (ticks 900, 1050, 1200) are all there.
- **Unlocking straight back into the same app is caught:** three times
  (Settings, Spotify, Gmail). That's the case the automations miss.
- **Change-only logging keeps the buffer tiny:** the 18-minute lock produced
  4 lines.
- **Lifetime is still unknown:** TT Lock Watch stops itself at tick 1600
  (about 14:45), so this run can't show when iOS would kill it. TT Watch now
  loops until iOS stops it, and its last heartbeat will tell.
- **Battery:** not logged. TT Watch now adds the battery level to its start
  line and its unlocked heartbeats.

The fusion code reconstructs this run as expected: Settings for 20.6 min,
locked 18.1 min, and so on.

## The tracker, built on that recipe (2026-10-21)

- **TT Watch** is TT Lock Watch for production: it logs changes and heartbeats
  to `tt-watch-<date>.txt`, and runs TT Sync after each locked stretch.
- **TT App Opened / TT App Closed** log every open and close, for all apps, to
  `tt-events-<date>.txt`.
- **TT Sync** uploads the new lines of both files to the relay.
- **The relay** (`server/`) runs remotely, fuses the streams
  ([`fusion.md`](fusion.md)) and keeps ActivityWatch up to date.
- **TT Safari** (`safari-extension/`, shipped in the iOS app) sends page events
  straight to the relay.

Still open: how long iOS lets TT Watch run, which decides how it gets
relaunched.

## TT Watch's first real day (2026-10-21): no time limit seen

From the relay's copy of every line, with the time each one arrived:

- **Longest run: at least 1 h 51 min** (run 875490, 16:27–18:18), through
  locks of 14, 7 and 4 minutes, partly on the charger (33% → 82%). Ticks
  averaged 2.42 s. Nothing suggests iOS stops the loop after a set time.
- **How the two runs after setup ended:** both went silent right at an unlock,
  the moment TT Watch writes its buffered lines and syncs:
  - 875490: last line 18:18:53; locked 18:19:41; unlocked by 18:19:55, when
    two automations (open and close Gmail) ran TT Sync in the same second.
    TT Watch never logged that unlock, and the automations kept logging normal
    use until 19:34.
  - 927451: last line was the unlock at 16:15:27, with an automation 0.7 s
    later. (This was also the hour TT Sync's name didn't match its callers,
    so it's the weaker case.)
  - The seven unlocks it survived all had the nearest automation 5.7 s or more
    away.
- **Hypothesis:** two copies of TT Sync at once (TT Watch's and an
  automation's) make one fail, and a failing Run Shortcut stops TT Watch. TT
  Watch now uploads its own file instead of running TT Sync, behind an offline
  guard. The two runs that died during setup (seconds after starting, while
  automations were being made in the Shortcuts app) aren't counted.
- **How fast lines arrive** (received minus written): opens and closes 0.4 s
  median, 5 s at p90; unlocks 1–8 s; watcher lines with no automation nearby
  wait for the next sync, median 7 s but up to 12 min.

## Open questions, next tests

1. **What triggers the banner: Is Locked, or the file write?** Run 1 wrote to
   the file while locked without trouble, which points at Is Locked. Two ways to
   confirm:
   - Poll Is Locked while locked, but buffer the lines in a variable instead of
     writing them. Flush to the file once Is Locked says No.
   - Poll while locked with everything except Is Locked (timestamp,
     `Get Current App`, file append). Does the banner still appear?
2. **The variable buffer may be capped at about 17 KB** (to verify). At about
   120 bytes per line, that's roughly 140 lines, or 8 minutes at a 3.5 s tick.
   Only the *transitions* matter, so the buffer can hold changes only: append a
   line when Is Locked differs from the previous tick. A night of sleep is then
   two lines.
3. **What exactly happens around the edge?** After locking, how many ticks and
   seconds until it fails? Does the shortcut stop, or keep running with failing
   steps? Does it recover after unlock? If the failure starts at a consistent
   point, the loop might avoid it, e.g. by pausing its Is Locked polls once it
   has seen "Yes".
4. **Brightness:** `Get Device Details` → Current Brightness with the screen off.
   If it reads 0, that's a lock/screen-off signal that may not need privacy
   permissions.
5. **Fallback:** the probe app's **Probe Lock State** action (T12), built by the
   `ios-probe` workflow. It checks data protection state inside our own app,
   which may not trigger the Shortcuts banner. Needs sideloading (section 4 of
   the test doc).
