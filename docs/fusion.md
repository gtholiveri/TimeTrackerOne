# How the phone's timeline is reconstructed

The relay (`server/ttserver/fusion.py`) turns the iPhone's raw log lines into
one timeline: for every moment, was the phone **in an app** (which one), **on
the Home Screen**, or **locked**? The Safari extension adds which page was on
screen while Safari was in front (`server/ttserver/web.py`). This page explains
the rules, why they're there, and how wrong the result can be.

## What the phone sends

**The watcher (TT Watch)** loops every ~2.3 s. Each tick it reads two things:
`Device Is Locked` (Yes/No) and `Get Current App` (the app's name, or empty on
the Home Screen). It writes a line only when one of them changed since the
previous tick, plus a heartbeat (`kind=beat`) every 150 ticks (about 6
minutes) so that a quiet stretch can be told apart from a watcher that died.

- Trial 2 showed this loop keeps running while the phone is locked (109 ticks
  in a row over 4 minutes, one every 2.28 s) and sees the unlock within one
  tick.
- It can't write files while the phone is locked (TT Lock Direct died doing
  that). So it keeps the locked lines in memory and writes them right after
  the unlock. They arrive late but carry their own timestamps.
- While locked, `Get Current App` keeps reporting the last app. Only
  `Device Is Locked` says the phone is locked.
- One launch lasts 1600 ticks (about an hour). How long iOS lets it run, and
  how it gets relaunched, is still being tested (TT Lock Watch).

**The automations (TT App Opened / TT App Closed)** log one line the instant
any app opens or closes, with the app's name. They're reliable: T1b found that
closes fire even on a straight power-off. But they have blind spots:

- Locking the phone fires a close. Unlocking fires nothing, so unlocking
  straight back into the same app is invisible to them.
- They can't tell the Home Screen from the Lock Screen: both are just "after
  a close, before the next open".

**TT Sync** uploads after every open and close, and TT Watch runs it after
writing a locked stretch. So the relay hears about every app switch within a
second or two. But TT Sync runs the moment the automation fires, and the
watcher only notices the change on its next tick. So the newest automation
event usually arrives *before* the watcher line describing it. The fusion
rules below are built around that lag.

## The algorithm

### 1. The watcher's timeline

Walk the watcher's lines in time order. Each `change` (or `beat`) line says
the phone's state at that moment: `locked` if Is Locked was Yes, otherwise
the app it names, or `home` if the app was empty. A state lasts until the
next line that reports a different one.

- **Gaps:** if no watcher line arrives for more than 15 minutes (`SILENCE`,
  2.5 heartbeats), the watcher wasn't running. The state in force ends one
  tick after the last line, and nothing is claimed for the gap.
- **End of a run:** a `kind=end` line closes the state.
- The newest state is left **open**: the watcher hasn't said it ended.

Accuracy: each transition is known to within one tick (≈2.3 s) after it
happened.

### 2. Snap transitions to automation events

Each watcher transition is moved back to the automation event that caused it,
if one is close enough. An event can only cause a transition if it came at
most one tick and a margin before the watcher saw the change
(`SNAP` = 4 s), and at most 0.5 s after it (the automation's own timestamp is
taken a moment after the app actually opened).

- Into an app: the `open` of that same app.
- Out of an app, into home or locked: the `close`.

Snapped transitions are exact to the automation's timing (well under a
second).

### 3. The automations' timeline

Separately, build a timeline from the automation events alone:

- `open(X)`: X from then on.
- A `close` followed within `SNAP` by an `open` is an app switch. The open
  does the work, so there's no Home Screen sliver between the two apps.
- A `close` of some other app than the current one is a late echo of an
  earlier switch, and is ignored.
- Any other `close` starts a stretch outside apps. If the next open came within
  20 s (`HOME_MAX`), it was the **Home Screen**; if later, the phone was
  **locked**. Nobody sits on the Home Screen for long, but an unlocked phone
  left alone also ends up locked.
- The newest close, with nothing after it, counts as Home Screen for its
  first 6 s (`LOCK_INFER`), then as locked. Had the phone stayed unlocked,
  opening the next app would have synced within seconds. Sitting on the Home
  Screen longer than that does get mislabelled as locked, until the next
  sync corrects it.

### 4. Combine

- The watcher's open last state ends at the first automation event after the
  watcher's last line. That's where the automations know more. If there is no
  such event, it runs on to now.
- The watcher's timeline is used wherever it exists. The automations'
  timeline fills everything else: gaps when the watcher wasn't running, and
  the stretch after the watcher's newest line.
- Back-to-back pieces with the same state are merged.

### 5. The live tail

The newest state is extended to the present and marked `provisional`. It's a
best guess, replaced as soon as more lines arrive. It's capped at 3 hours for
an app or the Home Screen and 24 hours for locked, so a phone that died
doesn't look like it's been in Safari all week.

## Confidence labels

Every interval carries one, and it's copied into ActivityWatch as
`tt_confidence`:

| Label | Meaning | Typical error |
| --- | --- | --- |
| `exact` | Its start is an automation event | < 1 s |
| `tick` | From the watcher | ≤ 1 tick (≈2.3 s) |
| `session` | An app's open..close from the automations, the watcher had no data | < 1 s at both ends |
| `inferred` | Home Screen or locked, guessed from the gap after a close | the label can be wrong; the times are right |
| `provisional` | Still ongoing, extended to now | until the next sync |

## Safari pages

The extension's content script reports, for each page:

- when it becomes visible or hidden;
- URL changes, including single-page-app navigation;
- title changes;
- a beat every 15 s while visible.

A page counts as on screen from its first visible report until it's hidden,
another page becomes visible, or its beats stop (40 s, `STALE`).

The page can't tell when the phone locks or Safari leaves the screen. So the
page timeline is clipped to the intervals where the fused phone timeline says
Safari was in front. Those pieces go to the `aw-watcher-web-safari_<phone>`
bucket. The page title also becomes the Safari window title in
`aw-watcher-window_<phone>`, just like browser window titles on a desktop.

## How ActivityWatch is kept in step

Late lines change history: a locked stretch arrives after the unlock, and the
live tail keeps moving. So the relay doesn't append to ActivityWatch. After
each upload, and every 20 s:

- It re-derives the timeline from the earliest new line (at least the last 6
  hours, and always including the newest interval).
- It makes ActivityWatch's events in that range equal to the derived ones: it
  deletes the events that are no longer right and inserts the missing ones.
  Running it twice changes nothing.

## Known limits

- **Home Screen vs. locked** is a guess whenever the watcher has no data for
  that moment (see step 3).
- **The watcher isn't always running.** One launch lasts about an hour, and
  how to relaunch it is still open. Without it, unlocking back into the same
  app is invisible, so that time counts as locked until the next app switch.
- **TT Sync needs the network.** Offline, the lines stay on the phone and go
  up with the next sync that works. The relay asks for whole files when it
  notices a gap. A failing TT Sync stops whatever ran it, which can stop TT
  Watch.
- **One phone per iCloud account.** The log files live in iCloud Drive >
  Shortcuts, which an iPad on the same account shares. An iPad would need its
  own file names.
- **Picture-in-picture and audio in the background** count as the app that
  was in front, not the one playing.
