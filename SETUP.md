# Setup runbook

Written for a Claude Code session running on Gabe's Windows laptop, to do the
installing and checking. The repo is at
`C:\Users\gabeo\OneDrive\Desktop\Projects\Software\UniversalTimeTracker\TimeTrackerOne`.
For what each piece is and why, read `docs/architecture-handoff.md` first. Work
through the steps in order. Run each step's check before moving on.
Steps marked **(Gabe)** need a person: start them, say exactly what to click
or type, and wait.

Ground rules:
- Use PowerShell. Use `curl.exe` (not the `curl` alias) for HTTP checks.
- The keys end up in `C:\Users\gabeo\tt-relay-keys.txt`. Never copy them into
  the repo or a commit. `TT_KEY` opens all the data; `TT_INGEST_KEY` only
  uploads.
- Long commands (`fly deploy`, the first mirror pass) can take several
  minutes. Give them a long timeout instead of cancelling them.
- If something fails, read the error, fix the cause, and carry on from that
  point. Don't rerun a step from the top if part of it already succeeded (see
  step 2).

## 1. Get the latest code

```powershell
cd C:\Users\gabeo\OneDrive\Desktop\Projects\Software\UniversalTimeTracker\TimeTrackerOne
git pull
```

If git says the branches have diverged (the history was rewritten once), ask
Gabe before running `git fetch; git reset --hard origin/main`: it discards
local changes to tracked files. `logs/` isn't tracked, so it's safe.

Check: `Test-Path server\deploy\fly-setup.ps1` is True.

## 2. The relay on Fly.io

1. Is flyctl installed? Run `fly version`. If not:
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   $env:Path += ";$env:USERPROFILE\.fly\bin"
   ```
2. Is it logged in? Run `fly auth whoami`. If not, **(Gabe)**: run
   `fly auth login` (or `fly auth signup` for a new account); it opens the
   browser. A new Fly account asks for a card.
3. Ask Gabe for the app name, or suggest `tt-relay-gabe`. It must be unused on
   Fly, and becomes `https://<name>.fly.dev`.
4. Run the setup script from the `server` folder:
   ```powershell
   cd server
   powershell -ExecutionPolicy Bypass -File deploy\fly-setup.ps1 -App <name>
   ```
   It does, in order:
   1. writes the name into `fly.toml`;
   2. `fly apps create`;
   3. `fly volumes create`;
   4. makes the two keys and stages them as secrets;
   5. `fly deploy --ha=false` (the image builds on Fly's side, a few minutes);
   6. writes `C:\Users\gabeo\tt-relay-keys.txt`.

   If the name is taken, it stops at the app-creation step: rerun it with
   another name. If it fails later, the app already exists, so don't rerun the
   script. Finish the remaining commands by hand ("By hand" in
   `server/README.md`), with the app name passed as `--app`. If the keys were
   already set, reuse them and write `tt-relay-keys.txt` in the same format
   the script uses.
5. Checks:
   - `curl.exe -s https://<name>.fly.dev/tt/health` shows `"ok": true`.
   - `curl.exe -s -u x:<TT_KEY> https://<name>.fly.dev/api/0/info` returns
     ActivityWatch's info JSON.
   - `curl.exe -s -o NUL -w "%{http_code}" https://<name>.fly.dev/api/0/info`
     prints `401` (no key, no access).
   - If anything is off: `fly logs --app <name>`.
6. Commit the `fly.toml` change (the app name isn't secret) and push.

## 3. ActivityWatch on this laptop

1. Install it: `winget install --id ActivityWatch.ActivityWatch -e`. If winget
   doesn't have it, download
   `https://github.com/ActivityWatch/activitywatch/releases/download/v0.13.2/activitywatch-v0.13.2-windows-x86_64-setup.exe`
   and run it with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`.
2. Start it. Find `aw-qt.exe` (under `$env:LOCALAPPDATA\Programs` or
   `C:\Program Files`) and launch it. It sits in the tray and starts the
   server, the window watcher and the AFK watcher.
3. Make it start at login, if the installer didn't: put a shortcut to
   `aw-qt.exe` in `[Environment]::GetFolderPath("Startup")`.
4. Check: `curl.exe -s http://localhost:5600/api/0/buckets/` lists
   `aw-watcher-window_<HOSTNAME>` and `aw-watcher-afk_<HOSTNAME>` within a
   minute of starting.
5. **(Gabe)**: in Chrome, install "ActivityWatch Web Watcher" from the Chrome
   Web Store. Then a bucket starting `aw-watcher-web-chrome` appears in the
   same list after a page or two.

## 4. Mirror the laptop to the relay

From the `server` folder, with the URL and `TT_KEY` from
`tt-relay-keys.txt`:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\desktop-mirror.ps1 -Relay https://<name>.fly.dev -Key <TT_KEY>
```

It does one pass in the foreground, copying up to 30 days, then starts in the
background and adds itself to Startup.

Checks:
- `Get-Content $env:LOCALAPPDATA\tt-mirror\mirror.log -Tail 20` shows no
  repeated `pass failed` lines.
- `curl.exe -s -u x:<TT_KEY> https://<name>.fly.dev/api/0/buckets/` includes
  this laptop's buckets.

## 5. Get the phone URL to the phone

The phone needs the line `TT Sync and TT Safari: https://<name>.fly.dev/tt/ingest?key=<TT_INGEST_KEY>`
from `tt-relay-keys.txt`. **(Gabe)**: send it to the phone, by email to
himself or through a notes app synced to the phone. Show him the line.

## 6. The iOS app with TT Safari

1. Download the app to Downloads:
   ```powershell
   curl.exe -L -o "$env:USERPROFILE\Downloads\TimeTracker-unsigned.ipa" https://github.com/gtholiveri/TimeTrackerOne/releases/download/ios-app/TimeTracker-unsigned.ipa
   ```
2. Check what's installed:
   - Sideloadly, from sideloadly.io.
   - iTunes and iCloud, which Sideloadly needs, as the versions from Apple's
     website, not the Microsoft Store.

   Download whatever is missing and start the installers.
3. **(Gabe)**:
   1. Plug in the iPhone and tap Trust on it.
   2. Drag the `.ipa` into Sideloadly, enter his Apple ID, click Start, and
      enter the two-factor code.
   3. On the iPhone:
      - Settings → Privacy & Security → Developer Mode on (it restarts);
      - Settings → General → VPN & Device Management → trust the Apple ID;
      - open TimeTracker once;
      - Settings → Apps → Safari → Extensions → TT Safari on, All Websites:
        Allow.
   4. In Safari, tap the extensions icon in the address bar → TT Safari, paste
      the URL from step 5, and Save.

## 7. The phone shortcuts

**(Gabe)**: follow "Setup" in `shortcuts/README.md` (also in the email "TimeTracker:
phone setup links"):
1. Add TT Sync first, paste the URL from step 5, run it once, and choose
   Always Allow.
2. Add TT App Opened, TT App Closed and TT Watch.
3. Create the two automations.
4. Start TT Watch once.

## 8. Check it all end to end

- After Gabe opens and closes a couple of apps:
  `curl.exe -s "https://<name>.fly.dev/tt/state?key=<TT_KEY>"`. His phone
  should be listed, with `current` showing the app he's in. If not,
  `.../tt/lines?key=<TT_KEY>` shows what arrived, and `source=safari` shows
  the extension's records.
- Open `https://<name>.fly.dev/` in the browser: user name anything, password
  `TT_KEY`. ActivityWatch should show the laptop and the phone as two hosts.

Report back what worked and what didn't, with the error text for anything
that failed.
