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
