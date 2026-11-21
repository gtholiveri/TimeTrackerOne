# Shortcuts

Written as code in [Cherri](https://github.com/electrikmilk/cherri) instead of
being assembled in the Shortcuts editor. Every push that changes this folder
compiles and signs them (`.github/workflows/shortcuts.yml`) and publishes them
on the `shortcuts` pre-release. To install one, open its link on the iPhone.

## The tracker

| Shortcut | Link | What it does |
| --- | --- | --- |
| TT Sync | [TT-Sync.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Sync.shortcut) | Hands the TimeTracker app the relay URL and this phone's name, and uploads anything it has queued. Asks for the relay URL when you add it. Run it once; after that the app uploads by itself. |
| TT App Opened | [TT-App-Opened.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-App-Opened.shortcut) | Hands an app opening to the TimeTracker app (its Log App Event action). |
| TT App Closed | [TT-App-Closed.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-App-Closed.shortcut) | Same, for an app closing (locking the phone counts). |
| TT Watch | [TT-Watch.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Watch.shortcut) | The lock/app watcher (the Lock Buffer recipe). Runs until iOS stops it. Logs changes, and a heartbeat with the battery level, to `tt-watch-<date>.txt` and to the TimeTracker app (Log TT Lines) after each unlock. Asks for the relay URL when you add it. |

All network traffic now goes through the TimeTracker app (`ios/`): its
actions queue the lines in the app and upload them when there's network, and
they never fail, so nothing shows an error banner offline. The app also
records location (visits and moves) and motion activity on its own.

How the relay combines them: [`docs/fusion.md`](../docs/fusion.md).

### Setup

You need the relay running first ([`server/README.md`](../server/README.md)),
with its URL and key at hand, and the TimeTracker app installed from
TestFlight.

1. **Open TimeTracker once**, tap *Allow location and motion*, choose
   *Allow While Using App*, then *Change to Always Allow* when iOS asks again,
   and allow Motion & Fitness.
2. **Add TT Sync**, answer its question with
   `https://<your relay>/tt/ingest?key=<TT_INGEST_KEY>`, and **run it once by
   hand**. It should say "all sent". The app now knows the relay.
3. **Add TT App Opened, TT App Closed and TT Watch** from their links. TT
   Watch asks for the same URL.
4. **Create the two automations** (or edit the ones you have; they keep
   working with the new shortcuts of the same names). In Shortcuts →
   Automation → **+**:
   - **App** → *Choose* → select every app → tick **Is Opened** only →
     **Run Immediately** → *Next* → pick **TT App Opened**.
   - Same again, ticking **Is Closed** only → **TT App Closed**.
   - Turn off *Notify When Run* on both.
5. **Start TT Watch** by tapping it, once.
6. Open and close a couple of apps, then check
   `https://<your relay>/tt/state?key=<TT_KEY>`: your phone should be there,
   with its current app. The TimeTracker app's *Waiting to upload* should be 0.

If something misbehaves, `https://<your relay>/tt/lines?key=<TT_KEY>` shows
exactly which lines arrived.

Before the app (until 2026-11-21), TT Sync uploaded the files itself and failed
without network, taking whatever ran it down with it.

## Test shortcuts

| Shortcut | Link | Question it answers |
| --- | --- | --- |
| TT Brightness | [TT-Brightness.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Brightness.shortcut) | Does Current Brightness read 0 with the screen off? (No.) |
| TT Lock Direct | [TT-Lock-Direct.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Lock-Direct.shortcut) | Is Locked written every tick. Survives locking? (No.) |
| TT Lock Buffer | [TT-Lock-Buffer.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Lock-Buffer.shortcut) | Is Locked polled, nothing written while locked. Survives locking? (Yes.) |
| TT Lock Watch | [TT-Lock-Watch.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Lock-Watch.shortcut) | The Lock Buffer recipe for an hour, logging only changes plus a heartbeat. How long does the loop live, and at what battery cost? |

They write `tt|key=value|...` lines to `tt-bright.txt`, `tt-lockdirect.txt`,
`tt-lockbuf.txt` and `tt-watch.txt` in iCloud Drive > Shortcuts.
`test-harness/analyze.py` reads them. Results: [`docs/findings.md`](../docs/findings.md).

## Notes on writing them

- `tt-actions.cherri` declares Get Current App, Get Device Details and
  Append to Text File with the identifiers and settings the Shortcuts app uses,
  and the TimeTracker app's actions. The pinned Cherri wraps an app action's
  `AppIntentDescriptor` as a Shortcuts dictionary, which iOS doesn't accept,
  so CI compiles unsigned, runs `fix-app-intents.py`, and signs with HubSign
  itself.
  Cherri's built-in versions lack Device Is Locked and Make New Line.
- Cherri reads `{...}` inside strings as variables, so the lines are key=value
  pairs, not JSON.
- Cherri only gives an action an ID (UUID) when its output is used, but iOS
  seems to remember "Always Allow" per action ID. So every file write captures
  its output (`const written1 = appendLine(...)`), and CI compiles with
  `--derive-uuids` so the IDs stay the same across rebuilds.
- The "Nothing" actions in the compiled shortcuts are Cherri's: they stop one
  action's output from flowing into the next as unintended input. Harmless.
- Join a list before writing it (`joinText`): Append to Text File given a list
  asks "Choose an item" and writes only the one you pick. Pass the separator
  explicitly; `joinText(@list)` crashes the pinned Cherri.
- iOS names an imported shortcut after its file, and CI turns the spaces in
  file names into dashes (GitHub would turn them into dots). So the shortcuts
  arrive as TT-Sync, TT-Watch and so on, and `run(...)` must use those names:
  `run("TT-Sync", ...)`, not `run("TT Sync", ...)`.
- Secrets never go in the source: the release is public. TT Sync's relay URL
  is an import question (`#question`), answered when the shortcut is added.
- To find the identifiers for another action, build it once on the phone, share
  the shortcut as an iCloud link, and read
  `https://www.icloud.com/shortcuts/api/records/<id>`: its `shortcut` field
  points to the unsigned plist.

Compile locally (signing needs network access to `hubsign.routinehub.services`):

```sh
cherri shortcuts/tt-sync.cherri --share=anyone --derive-uuids
```
