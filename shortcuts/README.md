# Shortcuts

Written as code in [Cherri](https://github.com/electrikmilk/cherri) instead of
being assembled in the Shortcuts editor. Every push that changes this folder
compiles and signs them (`.github/workflows/shortcuts.yml`) and publishes them
on the `shortcuts` pre-release. To install one, open its link on the iPhone.

## The tracker

One shortcut, plus two automations that call the TimeTracker app directly:

| Piece | What it does |
| --- | --- |
| [TT-Watch.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Watch.shortcut) | Polls lock state and the current app every ~2 s and logs changes, plus a heartbeat with the battery level. Keeps lines in memory while locked and hands them to the app (Log TT Lines) at the unlock. Runs until iOS stops it. Asks for the relay URL when you add it. |
| "App is opened" automation | Get Current App → TimeTracker **Log App Opened**. |
| "App is closed" automation | Get Current App → TimeTracker **Log App Closed** (locking counts as a close). |

Nothing here touches a file or the network. The app (`ios/`) queues every
line and uploads it when there's network, so nothing shows an error banner.
TT Watch has to stay a shortcut: only Shortcuts can read Device Is Locked and
the app in front.

How the relay combines them: [`docs/fusion.md`](../docs/fusion.md).

### Setup

You need the relay running ([`server/README.md`](../server/README.md)) and
the TimeTracker app from TestFlight.

1. Add **TT Watch** from the link and answer its question with
   `https://<your relay>/tt/ingest?key=<TT_INGEST_KEY>`. Tap it once to start
   it; that also gives the app the relay URL and the phone's name.
2. Shortcuts → Automation → **+** → **App** → *Choose* → every app → tick
   **Is Opened** only → **Run Immediately** → *Next* → **New Blank
   Automation**. Add **Get Current App**, then **Log App Opened** (under
   TimeTracker); its Current App is filled in with Get Current App's result.
   If it isn't, tap the field and pick *Current App*.
3. Same again with **Is Closed** only and **Log App Closed**.
4. Turn off *Notify When Run* on both.
5. Delete TT Sync, TT App Opened, TT App Closed and the old test shortcuts if
   you still have them (replace the actions in any old automations first).

`https://<your relay>/tt/state?key=<TT_KEY>` should show your phone and its
current app; `/tt/lines` shows exactly what arrived. The app's *Waiting to
upload* drops to 0 when online.

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
  seems to remember "Always Allow" per action ID. So every app action captures
  its output (`const logged = logLines(...)`), and CI compiles with
  `--derive-uuids` so the IDs stay the same across rebuilds.
- The "Nothing" actions in the compiled shortcuts are Cherri's: they stop one
  action's output from flowing into the next as unintended input. Harmless.
- Join a list before handing it on (`joinText`): Append to Text File given a list
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
