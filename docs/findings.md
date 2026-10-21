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

Still open: TT Lock Watch's one-hour run (lifetime and battery), which decides
how TT Watch gets relaunched.

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
