# Reading Gabe's activity data: a guide for an AI assistant

You've been given a **read-only key** to Gabe's activity tracker. This page is
everything you need to fetch the data and analyze it. The key can read
everything and change nothing.

## What the data is

One timeline of what Gabe does on every screen, accurate to seconds:

- **The laptop** (Windows): ActivityWatch's own watchers record the window in
  front (app and window title), whether he's at the computer (AFK = away from
  keyboard), and the browser tab (URL and page title).
- **The iPhone**: the app in front and whether the phone is locked, plus the
  Safari page. iOS doesn't let apps see this, so it's reconstructed from
  Shortcuts automations; each phone segment says how sure it is
  (`confidence`, below).

Everything lives on one always-on server, the **relay**, at
`https://tt-relay-gabe.fly.dev`. The laptop's history goes back to about late
September 2026, the phone's to 2026-10-21.

Why it exists: Gabe has ADHD, and his main problem isn't forgetting things but
getting captured: failing to disengage from something (YouTube, Instagram, a
rabbit hole, even good work at the wrong time) and losing hours. The data is
meant to show where attention actually goes, when the captures happen, what
triggers them, and how days and weeks compare.

## Authentication

Send the key with every request, in any of these ways:

| How | Example |
| --- | --- |
| Query parameter | `https://tt-relay-gabe.fly.dev/tt/summary?key=KEY` |
| Bearer token | `Authorization: Bearer KEY` |
| Basic auth password (any user name) | `curl -u muse:KEY ...` |

If your tools can only open URLs, use `?key=KEY`. Wrong or missing key: HTTP
401. The key is yours alone (each assistant gets its own, and requests are
logged by which key made them). Treat it as a password: don't print it in
shared output.

## Start here: the two analysis endpoints

These do the work the dashboard does (joining devices, dropping away time,
attaching browser tabs, categorizing, merging into one attention line), so
you get clean, categorized time instead of raw events.

### `GET /tt/summary`: per-day totals

The cheapest way to see days and weeks. Defaults to the last 7 days.

```
GET /tt/summary?key=KEY&days=7
GET /tt/summary?key=KEY&start=2026-10-20&end=2026-10-26
```

Answer (abridged):

```json
{
  "start": "2026-10-27T04:00:00-07:00",
  "end": "2026-11-01T18:31:02-08:00",
  "tz": "America/Los_Angeles",
  "start_of_day": "04:00",
  "attention_rules": {"priority": "phone", "backgroundApps": ["Clock", "Spotify", "Music", "Podcasts", "Maps"], "homeScreenCounts": true},
  "devices": [{"host": "Gabes-iPhone", "kind": "phone"}, {"host": "LAPTOP-XYZ", "kind": "desktop"}],
  "days": [
    {
      "day": "2026-10-31",
      "attention_seconds": 41250,
      "first_active": "2026-10-31T09:12:40-07:00",
      "last_active": "2026-11-01T01:47:03-07:00",
      "by_rating": {"productive": 18000, "neutral": 9000, "distracting": 14250},
      "by_top_category": [{"name": "Work", "seconds": 18000}, {"name": "Media", "seconds": 12000}],
      "by_category": [{"name": "Work > Programming", "seconds": 15000}, {"name": "Media > Video", "seconds": 9000}],
      "by_device_kind": {"desktop": 30000, "phone": 11250},
      "device_seconds": {"LAPTOP-XYZ": 31000, "Gabes-iPhone": 14000},
      "top_apps": [{"name": "Code.exe", "seconds": 14000}],
      "top_domains": [{"name": "youtube.com", "seconds": 8000}],
      "phone_unlocks": 87,
      "longest_productive_streak_seconds": 5400
    }
  ]
}
```

Per day:

- `day`: the tracking day. **A day starts at 04:00 local time**, not
  midnight, so 1 a.m. scrolling counts toward the evening before
  (`start_of_day`).
- `attention_seconds`: time on the merged attention line (below), so phone
  and laptop are never counted twice.
- `first_active` / `last_active`: first and last moment of attention in the
  day; good proxies for wake-up-to-screen and bedtime.
- `by_rating`: productive / neutral / distracting, from the category ratings
  Gabe set.
- `by_top_category`, `by_category`: category names are paths like
  `Work > Programming`; `Uncategorized` is anything no rule matched.
- `by_device_kind`: attention per kind of device. `device_seconds`: each
  device's own use, counted separately (these overlap, so they add up to more
  than `attention_seconds`).
- `top_apps`, `top_domains`: top 10 by attention (`&top=N` changes it).
  Domains come from browser tabs on either device.
- `phone_unlocks`: times the phone was unlocked (its in-use periods that
  started that day).
- `longest_productive_streak_seconds`: longest run of productive attention
  with no break over 2 minutes.

### `GET /tt/activity`: the segments themselves

The timeline, one row per stretch of the same thing.

```
GET /tt/activity?key=KEY                                  today so far
GET /tt/activity?key=KEY&days=3                           today and the 2 days before
GET /tt/activity?key=KEY&start=2026-10-30&end=2026-10-31  whole tracking days
GET /tt/activity?key=KEY&start=2026-10-31T13:00:00-07:00&end=2026-10-31T18:00:00-07:00
GET /tt/activity?key=KEY&days=7&format=csv&min_seconds=30
```

Parameters:

| | |
| --- | --- |
| `days=N` | Whole tracking days ending today (today counts as one). Default 1. |
| `start`, `end` | ISO 8601. A bare date means that tracking day's 04:00 start; as `end`, it includes that whole day. Times without an offset are in `tz`. `end` defaults to now. |
| `view` | `attention` (default): one merged line, at each moment the one thing that had his attention. `devices`: each device's use separately, overlapping in time. |
| `format` | `json` (default) or `csv` (same columns, much smaller; best for long ranges). |
| `min_seconds` | Leave out segments shorter than this (the line is split at every tab and window change, so there are many short ones). Totals then no longer add up. |
| `tz` | IANA time zone for the output times and day boundaries. Default `America/Los_Angeles`. |

At most **14 days per request**; ask for longer spans in pieces.

JSON answer: the same `start`, `end`, `tz`, `start_of_day`,
`attention_rules` and `devices` as the summary, plus `view`, `count` and
`segments`:

```json
{
  "start": "2026-10-31T13:00:00-07:00", "end": "2026-10-31T18:00:00-07:00", "view": "attention", "count": 412,
  "segments": [
    {"start": "2026-10-31T13:02:11-07:00", "end": "2026-10-31T13:09:40-07:00", "seconds": 449.0,
     "device": "LAPTOP-XYZ", "kind": "desktop", "app": "chrome.exe",
     "title": "Lecture 14 - Maxwell's equations - YouTube", "url": "https://www.youtube.com/watch?v=...",
     "domain": "youtube.com", "category": "Media > Video", "rating": "distracting", "score": -10,
     "confidence": ""},
    {"start": "2026-10-31T13:09:40-07:00", "end": "2026-10-31T13:21:05-07:00", "seconds": 685.0,
     "device": "Gabes-iPhone", "kind": "phone", "app": "Instagram", "title": "", "url": "", "domain": "",
     "category": "Media > Social Media", "rating": "distracting", "score": -10, "confidence": "exact"}
  ]
}
```

Segment fields:

| Field | Meaning |
| --- | --- |
| `start`, `end` | Local time with offset. Half-open: `end` is the next segment's `start` when there's no gap. |
| `seconds` | Length. Gaps between segments mean no device was in use (or, in the attention view, only a background app). |
| `device`, `kind` | Host name; `phone` or `desktop`. |
| `app` | Laptop: the executable (`Code.exe`, `chrome.exe`, `Discord.exe`). Phone: the app's name (`Instagram`, `Safari`), or `Home Screen`. |
| `title` | Laptop: the window title (for browsers, the page title). Phone: the Safari page title, otherwise empty (iOS doesn't expose more). |
| `url`, `domain` | The browser tab, when the app is a browser. Empty otherwise. |
| `category` | Gabe's own category, by his rules (regexes on app, title and URL; the deepest match wins). |
| `rating`, `score` | `productive` (score > 0), `neutral` (0 or none), `distracting` (< 0). A subcategory without its own score inherits its parent's. |
| `confidence` | Phone only. `exact`: from an open/close automation, accurate to a second. `tick`: from the 2-second polling loop. `inferred`: filled in between known points. `provisional`: the live tail, may still change. Empty on the laptop. |

How the attention line is merged (`attention_rules`): when the phone and the
laptop are both in use, `priority` (the phone) wins, except that apps in
`backgroundApps` (music, timers, maps) never claim attention, and the phone's
Home Screen only counts when nothing else does.

## Other endpoints

### `GET /tt/state`: the live feed

What each phone is doing right now and its recent fused timeline.
`hours=6` by default.

```json
{"now": "...", "devices": {"Gabe's iPhone": {
  "host": "Gabes-iPhone",
  "current": {"start": "...", "end": "...", "seconds": 312.4, "state": "app", "app": "Instagram", "confidence": "provisional"},
  "safari_page": {"url": "...", "title": "...", "end": "..."},
  "last_received": "...",
  "intervals": [{"start": "...", "end": "...", "seconds": 40.1, "state": "app|home|locked", "app": "...", "confidence": "..."}]
}}}
```

Phone only, times in UTC. The laptop's live state is in ActivityWatch (below).

### ActivityWatch's API: the raw events

Everything above is computed from ActivityWatch buckets, which you can also
read directly under `/api/0/` (GET only, plus queries). The API is
[documented here](https://docs.activitywatch.net/en/latest/api/rest.html).

- `GET /api/0/buckets/`: all buckets. Each has `id`, `type`, `hostname`,
  `client`. Types: `currentwindow` (`data: {app, title}`), `afkstatus`
  (`data: {status: "afk" | "not-afk"}`), `web.tab.current`
  (`data: {url, title, audible, incognito}`). The phone's buckets have client
  `tt-relay` and window events also carry `tt_confidence`.
- `GET /api/0/buckets/<id>/events?start=ISO&end=ISO&limit=-1`: events, each
  `{id, timestamp (UTC), duration (seconds), data}`. Careful: events that
  cross `start` or `end` come back **cut** to the range, and window events
  include time he was away (intersect with `afkstatus` not-afk yourself).
  `/tt/activity` handles both.
- `GET /api/0/settings`: Gabe's settings. `classes` is the category rules
  (`[{name: [...path], rule: {type: "regex", regex, ignore_case}, data: {score, color}}]`),
  `tt_attention` the attention rules, `startOfDay` the day start.
- `POST /api/0/query/` with `{"timeperiods": ["START/END"], "query": [...]}`:
  ActivityWatch's query language, if you want its own aggregations.

## Recipes

Fetch a week as CSV and load it in Python:

```python
import io, urllib.request, pandas as pd
BASE, KEY = "https://tt-relay-gabe.fly.dev", "KEY"
url = f"{BASE}/tt/activity?days=7&format=csv&key={KEY}"
df = pd.read_csv(io.StringIO(urllib.request.urlopen(url).read().decode()), parse_dates=["start", "end"])
df.groupby(df.start.dt.date).seconds.sum() / 3600            # hours of attention per day
df[df.rating == "distracting"].groupby("app").seconds.sum().nlargest(10) / 60
```

With curl:

```sh
curl -s -H "Authorization: Bearer $KEY" "https://tt-relay-gabe.fly.dev/tt/summary?days=14" | jq '.days[] | {day, h: (.attention_seconds/3600), unlocks: .phone_unlocks}'
```

A month: two `/tt/summary` calls (`start=2026-10-01&end=2026-10-14`, then
`2026-10-15` to `2026-10-31`), or several CSV `/tt/activity` calls.

Questions worth asking of the data:

- **Captures**: runs of distracting attention longer than, say, 20 minutes.
  What came right before (the trigger: a phone unlock, a Discord message, a
  YouTube link from a work page)? What time of day, how long?
- **Switching**: segments per hour and phone unlocks per hour in work
  blocks; how long focus lasts before the first switch.
- **Sleep drift**: `last_active` and `first_active` across days; late nights
  and how the next day goes.
- **Phone vs laptop**: how much attention the phone takes during laptop
  work blocks (in `view=devices`, phone segments that overlap laptop use).
- **Good vs bad days**: what the best days by productive share have in
  common, and the worst.

## Caveats

- **Current state (November 2026): phone time is undercounted.** The phone
  side still runs on Shortcuts that sync over the network, many of those runs
  fail, and the 2-second polling loop isn't running. Treat phone totals as a
  floor, and phone gaps as possibly missing data rather than time off the
  phone, until this note is removed.

- **Gaps**: the laptop is only tracked while it's on and ActivityWatch is
  running; its data reaches the relay within a minute or two, and after time
  offline it catches up when it's back. The phone's data reaches the relay
  when the phone syncs, usually within minutes; locked stretches arrive after
  the next unlock. Recent hours can still change.
- **Phone detail is coarser**: app only (no in-app titles except Safari
  pages), and if iOS stops the polling loop, the phone's timeline relies on
  open/close automations and can miss app-to-app switches. Prefer
  `confidence: exact` when precision matters.
- **Categories are Gabe's own rules**, not ground truth. Lots of
  `Uncategorized` time means the rules need work, not that the time was
  neutral; look at the apps and titles.
- **Idle but unlocked**: a phone left unlocked on a table counts as in use;
  the laptop counts as away after a few minutes without input.
- Times: the API answers in `tz` (Los Angeles by default, which switched
  from PDT -07:00 to PST -08:00 on 2026-11-01). Raw ActivityWatch events are
  UTC.
- The data is personal: window titles include message previews, document
  names and searches. Use it for analysis for Gabe; don't quote it anywhere
  else.
