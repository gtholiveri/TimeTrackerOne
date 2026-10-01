# Empirical tests

These tests answer the open questions about iOS behaviour that decide how the
iPhone/iPad watcher gets built. Run them roughly in order; T1, T2 and T4 decide
the most. The tools are in [`test-harness/`](../test-harness):

| File | What it is |
| --- | --- |
| `receiver.py` | Webhook receiver. Logs every POST to a JSON-lines file with its arrival time. Type a line into its terminal to drop a timestamped marker. |
| `analyze.py` | Reads receiver logs and the on-device log, merges them, and prints timelines, open/close pairing, polling-loop lifetimes, Get Current App values, latency and Safari signal counts. |
| `example-log.jsonl` | Made-up sample log. Run `python3 analyze.py example-log.jsonl` to see the output format. |
| `safari-probe/` | Safari Web Extension that logs which tab, navigation and visibility signals iOS Safari actually delivers (T10). |
| `ios-probe-app/LockProbe.swift` | App Intent that reports lock state from data protection (T12, only needed if T1 comes out badly). |

Both Python scripts use only the standard library (Python 3.8+). On Windows,
run them with `py` instead of `python3`.

## What the results decide

| Result | Consequence for the build |
| --- | --- |
| **T1:** `Get Current App` returns something distinct on the Lock Screen and Home Screen, and works from a loop while locked | Polling alone gives unlock time, lock detection and Home Screen time. No custom lock probe. |
| **T1:** it returns the last app when locked, errors, or the loop stops at lock | Add the lock-probe App Intent (T12) to the loop, or accept bounded unlock times. |
| **T2:** the automation's Shortcut Input names the app | Two automations total (opened, closed), and every close names its own app. |
| **T2:** only `Get Current App` identifies the app, and on close it reports the *next* app | Pair each close with whatever is currently open (`analyze.py --anon-close`, and the same rule in the relay). |
| **T2b:** new installs aren't covered automatically | Re-tick apps in both automations after installing something. |
| **T4:** loops live N minutes in the background | Relaunch polling at least every N minutes from time-of-day automations. |
| **T4:** app automations stall or queue while a loop runs | Polling can't overlap active use: only poll while locked (start from the close automation). |
| **T4/T6:** a failed network request stops the shortcut | Shortcuts only write locally (the custom app's App Intent), and the app syncs to the server. Expected, and already the plan. |
| **T10:** the background worker dies but content-script signals keep arriving | The Safari watcher is content-script driven, and the relay carries the last URL forward. The stock aw-watcher-web (background-driven) is not enough on iOS. |
| **T11:** iPad split-screen apps each fire open/close, or `Visible` returns several apps | iPad needs "several apps visible at once" handling. |

## Setup (once)

### 1. Run the receiver

On a computer on the same Wi-Fi as the phone:

```sh
cd test-harness
python3 receiver.py --out logs/day1.jsonl
```

Find the computer's LAN IP (`ipconfig` on Windows, `ipconfig getifaddr en0` on
macOS) and use `http://<that-ip>:8787/log` as the URL in the shortcuts below.
Allow Python through the Windows firewall on private networks when asked.

**Check it from the phone:** open `http://<that-ip>:8787/` in Safari. Type the
`http://` yourself: the receiver has no TLS, so `https://` just hangs, and the
receiver prints a "tried https://" line. If Safari warns that the connection
isn't secure, continue anyway. You should see a plain-text page reading
`0 records written to logs/day1.jsonl`. Once records come in, they're listed
below that line, newest first.

**On campus or other big Wi-Fi networks,** the computer's IP can change between
sessions. That breaks every shortcut that has the IP typed in. For tests that
run over days, install [Tailscale](https://tailscale.com) on the computer and
the phone and use the computer's Tailscale address (`100.x.y.z`) instead. It
stays the same on any network, including when the phone is on cellular.

- **Markers:** during a test, type what you're about to do into the receiver's
  terminal (for example `T3 lock via side button`) and press Enter. The analyzer
  prints records grouped under these markers.
- **If plain http is refused** or you want to test away from home, put a tunnel
  in front, for example `cloudflared tunnel --url http://localhost:8787`. It
  prints an https URL; start the receiver with `--token <secret>` and append
  `?token=<secret>` to the URL.
- iOS may ask whether Shortcuts can find devices on your local network, and
  whether each shortcut may connect to the IP. Allow both (Always Allow).

### 2. Build the shortcuts

Every shortcut builds one JSON line. It appends that line to a file on the phone
**first**, then POSTs the same text to the receiver. Keep that order: a failed
`Get Contents of URL` stops the rest of the shortcut, and the on-device file is
how T6 measures what the network lost.

**Timestamp** (used everywhere): `Current Date` → `Format Date`, Date Format
*Custom*, format string `yyyy-MM-dd'T'HH:mm:ss.SSSXXX`. That gives a value like
`2026-09-25T14:03:11.123-04:00`. Referred to below as **TS**.

**Log step** (used everywhere, after building the line as a `Text` action):
1. `Append to Text File`: append the Text to `tt-log.jsonl` in the Shortcuts
   folder, with **Make New Line** on.
2. `Get Contents of URL`: your receiver URL, Method POST, header
   `Content-Type: application/json`, Request Body *File*, set to the Text. If
   your iOS version won't take Text as a file body, use Request Body *JSON* and
   add the same fields there.

#### A-Open and A-Close (personal automations)

Shortcuts → Automation → + → **App** → Choose: select every app (use the
category rows and any select-all option the picker offers), tick **Is Opened**
only → **Run Immediately**, **Notify When Run** off → New Blank Automation.
Actions:

1. TS (as above)
2. `Get Current App`
3. `Text`:
   ```
   {"src":"ios","kind":"open","ts":"TS","input":"Shortcut Input","cur":"Current App"}
   ```
   Insert the variables where the words are. For `Current App`, tap the
   variable and pick its name property. While you're there, note which other
   properties it offers. If there's a bundle identifier, add
   `,"bundle":"<that property>"` to the line.
4. Log step.

Make **A-Close** the same way, with only **Is Closed** ticked and
`"kind":"close"`.

#### TT Poll (a regular shortcut)

1. `If` Shortcut Input has any value → `Set Variable` **Ctx** to Shortcut Input;
   Otherwise → `Text` "manual" → `Set Variable` **Ctx**; End If.
2. `Random Number` between 100000 and 999999 → `Set Variable` **Run**.
3. `Repeat` 2000 times:
   1. TS
   2. `Get Current App`
   3. `Text`:
      ```
      {"src":"ios","kind":"poll","ts":"TS","cur":"Current App","run":"Run","tick":"Repeat Index","ctx":"Ctx"}
      ```
   4. Log step
   5. `Wait` 10 seconds (use 5 for T1)
4. End Repeat, then one more TS → `Text` with `"kind":"poll.end"` (same fields)
   → Log step.

If a run never logs `poll.end`, iOS killed it. `analyze.py --section runs` shows
each run's lifetime.

#### TT Poll Nested

One action: `Run Shortcut` **TT Poll**, with the text `nested` as input. Used in
T4 to test whether launching the loop through another shortcut changes its
lifetime.

#### Launch automations (created per test)

Automation → + → **Time of Day** → pick a time → Daily → Run Immediately, Notify
off → New Blank Automation → `Text` with a context label (for example
`tod-locked`) → `Run Shortcut` **TT Poll** with that Text as input.

### 3. Collect and analyze

The receiver log is already on the computer. For the on-device log, open the
Files app → iCloud Drive → Shortcuts (or On My iPhone → Shortcuts if iCloud
Drive is off) → `tt-log.jsonl` → Share → AirDrop, Mail, or iCloud for Windows.
Delete or rename it after each test day so logs stay separate.

```sh
python3 analyze.py logs/day1.jsonl device-day1.jsonl                  # everything
python3 analyze.py logs/day1.jsonl --section timeline --since 2026-09-25T14:00   # one test
python3 analyze.py logs/day1.jsonl --section sessions --section runs
```

`--since` and `--until` take ISO times (`2026-09-25T14:00`), read as local time
unless they carry an offset.

### 4. The probe app (only for T10 and T12)

The app (lock-probe action plus the Safari probe extension) is built by GitHub
Actions on a macOS runner, so you don't need a Mac. The project is defined in
`ios/project.yml`; the workflow is `.github/workflows/ios-probe.yml`.

**Build it with your receiver URL baked in:** on GitHub, open Actions → *iOS
probe app* → *Run workflow*. Put the receiver URL in the box, e.g.
`http://100.x.y.z:8787/log`, and run it. When it finishes, download the
`TTProbe-unsigned-ipa` artifact from the run page and unzip it to get
`TTProbe-unsigned.ipa`. Pushes to `main` also build it, with the placeholder
URL from `background.js`.

**Install it from Windows with [Sideloadly](https://sideloadly.io)**, which
signs the app with your Apple ID (a free one works):

1. Install Sideloadly, plus the non-Microsoft-Store versions of iTunes and
   iCloud, which it needs for the USB connection.
2. Plug in the iPhone, drop `TTProbe-unsigned.ipa` into Sideloadly, enter your
   Apple ID, and start.
3. On the iPhone, turn on Settings → Privacy & Security → **Developer Mode**
   (it restarts the phone). Then trust your Apple ID under Settings → General →
   VPN & Device Management.
4. Open TT Probe once while unlocked. That creates the lock probe's canary file.
5. Enable the extension: Settings → Apps → Safari → Extensions → TT Safari
   Probe → on, **All Websites: Allow**, and allow it in Private Browsing.

With a free Apple ID the app stops launching after 7 days; sideload it again to
renew. If the Safari extension doesn't appear after sideloading, the
extension most likely wasn't signed; check Sideloadly's log for the `.appex`.

If plain `http://` requests from the extension fail, rebuild with an https
tunnel URL instead.

## Tests

For every test: start the receiver with a fresh `--out` file, type a marker
before each step, and hold each state for at least 20 seconds, so a 5–10 s
poll catches it more than once.

### T1: What does `Get Current App` return, and when?

**Why:** this decides whether polling alone closes the unlock gap and gives
Home Screen time, or whether a lock probe is also needed.

**Setup:** TT Poll with `Wait` 5 seconds. Start it by hand from the Shortcuts
app, then open Notes.

**Steps:**
1. Stay in Notes.
2. Go to the Home Screen. Swipe to another page, then App Library, then
   Spotlight.
3. Lock with the side button and wait 60 s.
4. Tap to wake. Stay on the Lock Screen without Face ID (look away, or cover the
   camera) for 20 s.
5. Let Face ID unlock you, but don't swipe up. Stay on the Lock Screen for 20 s.
6. Swipe up, back into Notes.
7. Lock again and wait 2 minutes. Does the loop keep ticking?
8. Optional, to see what gets reported: Notification Center over Notes, Control
   Center, the app switcher.
9. Play a video in Safari, start Picture in Picture, then go to the Home Screen.
10. If you use StandBy: charge the phone locked in landscape for 1 minute.

**Look at:** `--section apps --section timeline --section runs`. For each state,
note what `cur` was, and whether ticks kept arriving while locked.

**Pass if:** the Lock Screen (locked and Face-ID-unlocked) and the Home Screen
each give a value that differs from the last app: empty, SpringBoard, or an
error. If the loop dies exactly at lock, the action probably errors while
locked. Note it and run T12.

### T2: Does the automation know which app fired?

**Setup:** A-Open and A-Close installed.

**Steps:**
1. Go Notes → Safari → Messages → Notes, each time through the Home Screen.
2. Lock, then unlock back into Notes.
3. Go Notes → Safari.

**Look at:** `--section closecur --section timeline`.
- Does `input` carry the app name on both opens and closes?
- On closes, is `cur` the app being closed, or the one being opened?

**T2b, new installs:** install any free app you don't have, then open and close
it. If no events appear, "select every app" is a snapshot, and new apps have to
be ticked by hand.

### T3: Which transitions fire which events?

**Why:** the relay's pairing rules assume unlocking straight into an app is the
*only* case where an app is in front without an open event. This checks for
other cases.

**Steps**, one per marker. For each, note which events fired, in what order
(close before open, or the other way?), and how far apart:

| # | Transition |
| --- | --- |
| 1 | App → another app via the Home Screen |
| 2 | App → app with the home-bar swipe (quick switch) |
| 3 | App → app via the app switcher |
| 4 | App → app by tapping a notification banner |
| 5 | App → app via a link, e.g. an App Store link from Messages, a YouTube link from Safari |
| 6 | Launch from Spotlight, and from Siri |
| 7 | App → Home Screen |
| 8 | Lock via side button; lock via Auto-Lock timeout |
| 9 | Unlock straight into the app (expected: nothing fires) |
| 10 | Unlock onto the Home Screen (lock while on Home, then unlock) |
| 11 | Incoming call while in an app: answer, hang up |
| 12 | Lock Screen camera (swipe left), then back |
| 13 | Share sheet to another app's extension, e.g. share a page to Messages |
| 14 | Run a shortcut from Back Tap or the Action Button while in an app |

**Look at:** `--section timeline --section sessions`. Any "close with no
matching open" outside row 9 is a second resume case the relay has to handle.

### T4: How long does a background loop live, and does it block automations?

**Why:** this sets the polling relaunch cadence, and tells whether polling can
run while you're using the phone.

**Contexts.** Run each one with its own context label, and fill in the table
from `--section runs`:

| Ctx label | How it's launched | Lifetime | Ended normally? |
| --- | --- | --- | --- |
| `manual` | By hand in the Shortcuts app, then switch to another app | | |
| `tod-unlocked` | Time-of-day automation while you're using the phone | | |
| `tod-locked` | Time-of-day automation while the phone is locked and untouched | | |
| `nested` | Time-of-day automation → TT Poll Nested → TT Poll | | |
| `lpm` | Repeat `tod-locked` with Low Power Mode on | | |
| `from-close` | Temporarily add `Run Shortcut TT Poll` to the end of A-Close, then lock | | |
| `wait30` | `tod-locked` with Wait 30 s instead of 10 s. Is the limit wall-clock time or tick count? | | |

**Concurrency** (during a `tod-unlocked` run): switch apps 5 times. In
`--section latency` and `--section timeline`, do the open/close events arrive
promptly while the loop runs, or only after it dies? Does starting an app
automation kill the loop (the run ends right at your first switch)?

**Network failure** (during a `tod-locked` run): turn on Airplane Mode for 60 s.
If the run ends at that moment, the failed request killed it. Take the log step
in TT Poll down to just the file append and rerun `tod-locked`: that matches the
final design, where shortcuts only write locally.

**Overnight:** create time-of-day automations every 30 minutes from 00:00 to
07:30, each launching TT Poll with `night` as input. In the morning, leave the
phone locked in an app you had open, unlock straight into it, use it for a
minute, then switch apps. Check:
- `--section runs`: how much of the night had a live loop?
- `--section sessions`: was the resume after unlock resolved from polls?

### T5: Are any open/close events dropped?

**Steps:**
1. Switch between two apps 20 times in about 30 seconds (home-bar swipe).
2. Then use the phone normally for an hour.

**Look at:** `--section sessions --section summary`.
- **Rapid switching:** 20 opens and 20 closes, every open paired. You only care
  about drops here; timing precision doesn't matter.
- **Normal hour:** no "closes with no matching open" except after unlocks, and
  no "opens that never closed" except the last one.
- `--section latency` should show small receive delays and no negative ones. A
  negative delay would mean a clock problem.

### T6: Offline, and writes while locked

**Steps:**
1. Turn on Airplane Mode. Use three apps for about 5 minutes. Turn it off.
2. Collect `tt-log.jsonl` and run `analyze.py receiver.jsonl device.jsonl`.

**Look at:**
- `summary`: "only in device.jsonl" is what network-only logging would have
  lost. `sessions` on the merged logs should be complete.
- The device log should have ticks from T4's `tod-locked` run. That confirms the
  file append works while the phone is locked.

### T7: Power loss and reboot

1. In Notes, power off normally (slide to power off). Did A-Close fire?
2. In Notes, force-restart (volume up, volume down, hold side). This simulates
   the battery dying. Expect no close.
3. After boot, **before** the first unlock, let a time-of-day automation fire.
   Schedule it 2 minutes ahead before restarting. Did it run?
4. After the first unlock, open an app. Did A-Open fire?

**Decides:** how the relay ends a session with no close: at the last poll tick
or event before the gap, rather than throwing the session away.

### T8: Conditions that might silence automations

Repeat a short T5 (5 switches plus a lock/unlock) under:
- Low Power Mode
- a Focus (Work, and Sleep)
- Screen Time Downtime, if you use it
- the first day after the next iOS update

### T9: Battery cost

**Day A:** automations only. **Day B:** automations plus polling, at the
cadence T4 suggests and overnight. Compare Settings → Battery → Shortcuts, and
the total. This decides how aggressively to poll, e.g. only while locked, or
only when a resume is unresolved.

### T10: Which Safari signals actually arrive? (probe app)

**Why:** the stock aw-watcher-web depends on its background worker (tab events
plus a 1-minute alarm), and background workers on iOS Safari are known to stop
responding. This test shows which channel to build on.

**Steps**, with markers:
1. Open three sites in tabs, then switch between them.
2. Navigate inside YouTube, Reddit or X. These change the URL without a page
   load.
3. Switch to another app for 30 s, then back.
4. Lock for 60 s while Safari is in front, then unlock.
5. Leave a page open, untouched, for 5 minutes.
6. Open a private tab.
7. Turn on Reader mode.
8. Open a link from another app into Safari.
9. Open a link inside an in-app browser (e.g. in Reddit's app). Expect nothing:
   this confirms that time counts toward that app.

**Look at:** `--section safari --section runs --section timeline`.
- `safari-bg` runs: how long the background worker stays alive, and whether the
  alarm wakes it again.
- **Dropped messages:** records missing by sequence number, i.e. messages from
  the content script that never arrived.
- **Channel:** did records arrive via `bg`, `pending` (parked and sent later) or
  `direct` (if you set `DIRECT` in `content.js`)?
- **URL changes:** does `safari.cs.url` catch in-page navigation that
  `safari.tabs.updated` misses, or the other way round?
- Does `safari.cs.visibility` fire when you leave Safari and when you lock?

### T11: iPad

Repeat T1–T3 briefly on the iPad, plus:
- `Get Current App` with its **Current** and **Visible** options, in Split View,
  Slide Over and Stage Manager with several windows.
- Do open/close events fire when focus moves between two apps in Split View,
  and when entering or leaving Stage Manager?
- Lock by closing the Smart Folio or cover.
- If the iPad has no passcode, the T12 probe can't work (data protection needs
  one).

### T12: Lock probe (only if T1 fails)

**Setup:** add the `Probe Lock State` action (from the probe app) to TT Poll's
loop, and add `"probe":"<its result>"` to the poll line.

**Steps:**
1. Lock. How many seconds until the result says `locked`? About 10 is expected.
2. Face ID unlock without swiping up: `unlocked` already?
3. StandBy.
4. Does the action run at all from a locked `tod-locked` loop?

**Look at:** `--section apps` for the probe counts, and `--section timeline`.

### Ground-truth check (after the above)

Start a screen recording from Control Center and type a marker at the same
moment. Use the phone normally for an hour, including a couple of locks and
unlocks straight back into an app. Stop, then compare `--section sessions` with
the recording, whose timeline gives elapsed time from your marker. Any block
that's missing or clearly wrong points back to one of the tests above.
