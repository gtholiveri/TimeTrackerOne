# Shortcuts

Written as code in [Cherri](https://github.com/electrikmilk/cherri) instead of
being assembled in the Shortcuts editor. Every push that changes this folder
compiles and signs them (`.github/workflows/shortcuts.yml`) and publishes them
on the `shortcuts` pre-release. To install one, open its link on the iPhone.

## The tracker

Three shortcuts, nothing else:

| Shortcut | Link | What it does |
| --- | --- | --- |
| TT Watch | [TT-Watch.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Watch.shortcut) | Polls lock state and the current app every ~2 s and logs changes, plus a heartbeat with the battery level. Runs until iOS stops it. Asks for the relay URL when you add it and hands it to the app. |
| TT App Opened | [TT-App-Opened.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-App-Opened.shortcut) | Run by the "App is opened" automation: records the opening. |
| TT App Closed | [TT-App-Closed.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-App-Closed.shortcut) | Run by the "App is closed" automation: records the closing (locking counts). |

None of them touch the network. They hand their lines to the TimeTracker app
(`ios/`), which queues them and uploads when there's network, so they never
show an error banner. TT Watch also keeps a copy in `tt-watch-<date>.txt` in
iCloud Drive > Shortcuts.

How the relay combines them: [`docs/fusion.md`](../docs/fusion.md).

### Setup

You need the relay running ([`server/README.md`](../server/README.md)) and
the TimeTracker app from TestFlight.

1. Add **TT Watch**, **TT App Opened** and **TT App Closed** from the links.
   TT Watch asks for `https://<your relay>/tt/ingest?key=<TT_INGEST_KEY>`.
2. Two automations in Shortcuts → Automation → **+** (existing ones keep
   working, the names haven't changed):
   - **App** → *Choose* → every app → **Is Opened** only → **Run Immediately**
     → **TT App Opened**.
   - Same with **Is Closed** only → **TT App Closed**.
   - *Notify When Run* off on both.
3. Start **TT Watch** by tapping it once. That also gives the app the relay
   URL (or paste it in the app).
4. Delete TT Sync and the old test shortcuts (TT Brightness, TT Lock Direct,
   TT Lock Buffer, TT Lock Watch) if you still have them.

`https://<your relay>/tt/state?key=<TT_KEY>` should show your phone and its
current app; `/tt/lines` shows exactly what arrived. The app's *Waiting to
upload* should drop to 0 when online.

The retired experiments are in [`test-harness/shortcuts/`](../test-harness/shortcuts).

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
  arrive as TT-Watch, TT-App-Opened and so on; `run(...)` would have to use
  those names.
- Secrets never go in the source: the release is public. TT Watch's relay URL
  is an import question (`#question`), answered when the shortcut is added.
- To find the identifiers for another action, build it once on the phone, share
  the shortcut as an iCloud link, and read
  `https://www.icloud.com/shortcuts/api/records/<id>`: its `shortcut` field
  points to the unsigned plist.

Compile locally (signing needs network access to `hubsign.routinehub.services`):

```sh
cherri shortcuts/tt-watch.cherri --skip-sign --derive-uuids
python3 shortcuts/fix-app-intents.py 'shortcuts/TT Watch_unsigned.shortcut' /tmp/tt-watch.plist
```
