# Test shortcuts

Written as code in [Cherri](https://github.com/electrikmilk/cherri) instead of
being assembled in the Shortcuts editor. Every push that changes this folder
compiles and signs them (`.github/workflows/shortcuts.yml`) and publishes them
on the `shortcuts` pre-release. To install one, open its link on the iPhone:

| Shortcut | Link | Question it answers |
| --- | --- | --- |
| TT Brightness | [TT-Brightness.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Brightness.shortcut) | Does Current Brightness read 0 with the screen off? |
| TT Lock Direct | [TT-Lock-Direct.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Lock-Direct.shortcut) | Is Locked written every tick, but to iCloud Drive > Shortcuts. Survives locking? |
| TT Lock Buffer | [TT-Lock-Buffer.shortcut](https://github.com/gtholiveri/TimeTrackerOne/releases/download/shortcuts/TT-Lock-Buffer.shortcut) | Is Locked polled, nothing written while locked. Survives locking? |

They write `tt|key=value|...` lines to `tt-bright.txt`, `tt-lockdirect.txt` and
`tt-lockbuf.txt` in iCloud Drive > Shortcuts. `test-harness/analyze.py` reads
them.

- `tt-actions.cherri` declares Get Current App, Get Device Details and
  Append to Text File with the identifiers and settings the Shortcuts app uses.
  Cherri's built-in versions lack Device Is Locked and Make New Line.
- Cherri reads `{...}` inside strings as variables, so the lines are key=value
  pairs, not JSON.
- To find the identifiers for another action, build it once on the phone, share
  the shortcut as an iCloud link, and read
  `https://www.icloud.com/shortcuts/api/records/<id>`: its `shortcut` field
  points to the unsigned plist.

Compile locally (signing needs network access to `hubsign.routinehub.services`):

```sh
cherri shortcuts/tt-brightness.cherri --share=anyone
```
