# The relay

A small always-on server. The iPhone's shortcuts and the Safari extension send
their raw lines here, and the relay:

1. stores every line (SQLite, deduplicated), as the source of truth;
2. fuses the phone's streams into one timeline (`ttserver/fusion.py`; the
   rules are in [`docs/fusion.md`](../docs/fusion.md));
3. writes that timeline into ActivityWatch as a watcher for the phone, with
   the same bucket types the desktop watchers use. Recent history is
   re-derived as late lines arrive, so ActivityWatch converges on the best
   reconstruction:
   - `aw-watcher-window_<phone>`: app and page title
   - `aw-watcher-afk_<phone>`: locked or not
   - `aw-watcher-web-safari_<phone>`: Safari URL and title

It runs ActivityWatch's own server (aw-server-rust) inside the same container,
reachable only through the relay, and serves the ActivityWatch web UI behind
your key. It keeps receiving and updating while your laptop is off.

```
iPhone shortcuts ──TT Sync──▶  /tt/ingest  ┐
Safari extension ───────────▶  /tt/safari  ├─▶ relay ─▶ aw-server-rust ─▶ web UI (/)
you / an agent   ◀──────────── /tt/state   ┘
```

## Endpoints

`KEY` is the `TT_KEY` you set. Give it as `?key=`, as a bearer token, or as the
password of HTTP basic auth (any user name). If you also set `TT_INGEST_KEY`,
that key works for the two upload endpoints and nothing else. Put it on the
phone (TT Sync and TT Safari), so a key copied from there can't read your
history.

| | |
| --- | --- |
| `POST /tt/ingest?key=KEY&file=NAME&lines=N&mode=tail\|full&dev=DEVICE` | Lines from one phone log file. With `mode=tail`, the body is the last lines of a file that has `N` lines; the answer is `full` when the relay is missing earlier lines, and TT Sync then sends the whole file. Otherwise `ok`. |
| `POST /tt/safari?key=KEY` | The Safari extension's records (a JSON array, or one JSON object per line). |
| `GET /tt/state?key=KEY&hours=6` | The fused timeline per device, with the current state. This is the live feed. |
| `GET /tt/lines?key=KEY&source=ios\|safari&hours=24` | The raw lines, for debugging. |
| `POST /tt/labels?key=KEY` | Short labels for the dashboard's timeline blocks, from a free LLM API (below). Body `{"blocks": [{"id", "items": [{"subject", "app", "title", "seconds", "category"}]}]}`, answer `{"labels": {id: label}, "model": ...}`. `TT_KEY` only. |
| `GET /tt/health` | No key needed. |
| `GET /app/` | The dashboard (below), behind basic auth. |
| everything else | The ActivityWatch web UI and API, behind basic auth. |

## Deploy on Fly.io (least upkeep)

Fly runs the container on a small always-on machine with a disk, and gives it
an HTTPS address. It costs about $2–3 a month (a shared-cpu-1x 256 MB machine
plus a 1 GB volume), and Fly asks for a card when you sign up.

**From Windows**, in PowerShell:

1. Install flyctl, then open a **new** PowerShell window so it's on your PATH:
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
2. Sign up (or `fly auth login` if you have an account):
   ```powershell
   fly auth signup
   ```
3. Get the latest code and run the setup script. Pick an app name nobody else
   has used; it becomes `https://<name>.fly.dev`.
   ```powershell
   cd <your TimeTrackerOne folder>
   git pull
   cd server
   powershell -ExecutionPolicy Bypass -File deploy\fly-setup.ps1 -App tt-relay-<yourname>
   ```
   It creates the app and its disk, generates the two keys, deploys (the
   image is built on Fly's side; the first build takes a few minutes), and
   writes the keys and all the URLs you need to `tt-relay-keys.txt` in your
   home folder. If the name is taken it stops at the first step; run it again
   with another name.
4. Check it: open `https://<name>.fly.dev/tt/health` (should say `"ok": true`),
   then `https://<name>.fly.dev/` and sign in with any user name and `TT_KEY`
   as password. That's the ActivityWatch web UI.

Later updates: `git pull`, then `fly deploy` in the `server` folder.

**By hand** (any OS), from the `server/` folder, after putting the app name in
`fly.toml`:

```sh
fly apps create <name>
fly volumes create tt_data --size 1 --region lax --app <name> --yes
KEY=$(openssl rand -hex 24); INGEST=$(openssl rand -hex 24)
echo "TT_KEY=$KEY  TT_INGEST_KEY=$INGEST"   # save both: fly won't show them again
fly secrets set TT_KEY=$KEY TT_INGEST_KEY=$INGEST --app <name> --stage
fly deploy --ha=false
```

## Deploy on any Linux server

With Docker installed (Hetzner, DigitalOcean, an Oracle free VM, a home
server with ports 80 and 443 open):

```sh
git clone https://github.com/gtholiveri/TimeTrackerOne && cd TimeTrackerOne/server/deploy
echo "TT_KEY=$(openssl rand -hex 24)" > .env
echo "TT_INGEST_KEY=$(openssl rand -hex 24)" >> .env
echo "TT_DOMAIN=tt.example.com" >> .env   # no domain? use <server-ip>.sslip.io
docker compose up -d --build
```

Caddy gets the HTTPS certificate on its own. The Docker image uses
ActivityWatch's official x86_64 build; on an ARM server (e.g. Oracle's free
Ampere VM), build aw-server-rust from source instead.

## Point the phone at it

1. **TT Sync:** when you add it, it asks for the ingest URL. Answer
   `https://<your relay>/tt/ingest?key=<TT_INGEST_KEY>` (or `TT_KEY` if you
   didn't set an ingest key). To change it later, delete
   and re-add TT Sync from its link.
2. **TT Safari:** in Safari, tap the extensions button in the address bar →
   TT Safari, paste the same URL, and tap Save.

Install and automation steps for the shortcuts: [`shortcuts/README.md`](../shortcuts/README.md).

## The desktop

The desktop is tracked by ActivityWatch's own watchers, writing to the
ActivityWatch server on the computer as usual. `ttserver/mirror.py` copies
those buckets to the relay every minute, so the relay's ActivityWatch has the
phone and the computer together, and keeps the computer's history while it's
off. It only reads from the local server, and it catches up after time
offline.

1. Install ActivityWatch: <https://activitywatch.net/downloads/> (Windows:
   the `setup.exe`). It starts in the tray with the window and AFK watchers;
   <http://localhost:5600> shows its dashboard. Let it start at login.
2. For browser tabs, add the ActivityWatch Web Watcher extension
   (Chrome Web Store, or Firefox Add-ons).
3. Start the mirror (needs Python 3), in PowerShell from the `server` folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\desktop-mirror.ps1 -Relay https://<name>.fly.dev -Key <TT_KEY>
   ```
   It copies the last 30 days once, then keeps running in the background as
   the scheduled task "TimeTracker mirror": started a minute after each login
   and restarted within 5 minutes if it stops. Its log is
   `%LOCALAPPDATA%\tt-mirror\mirror.log`. Run the script from a normal
   PowerShell window: run from inside a packaged app's terminal (the Claude
   desktop app, say), its view of `%LOCALAPPDATA%` is a private copy, though
   the mirror still works because it creates its folder itself.

On macOS or Linux, run `python3 -m ttserver.mirror --relay ... --key ...` from
the `server` folder at login instead.

## The dashboard

`https://<name>.fly.dev/app/`, with the same sign-in as the ActivityWatch web
UI (any user name, `TT_KEY` as password). It reads ActivityWatch's data
through the relay and changes none of it:

- **Today:** what each device is doing now, today's total split by category
  and by rating, and the day as one merged line or one lane per device. Works
  on the phone.
- **Explore:** a filter row (range, attention or all device time, device,
  category, rating, search) above stat tiles, time per day or hour stacked by
  category, rating or device, a weekday-by-hour heatmap, a top table grouped
  any way, day strips and the activity log.
- **Categories:** ActivityWatch's own categories (the `classes` setting, so
  its web UI stays in step), with a live preview of what each rule catches, a
  productive / neutral / distracting rating (ActivityWatch's `score`), and an
  Uncategorized list to triage from.
- **Attention:** the rules that merge phone and laptop into one line (which
  device wins, background phone apps like Clock that never count, the Home
  Screen), stored as the `tt_attention` setting, with a preview of a day.

Source: `dashboard/` (Vite, React, TypeScript; no other runtime
dependencies). The Docker image builds it, and the relay serves
`dashboard/dist` at `/app/`.

```sh
cd server/dashboard
npm install
npm run dev     # http://localhost:5173/app/, against the real relay
npm test
```

`npm run dev` proxies `/api` and `/tt` to the relay and adds the key itself,
taking the relay URL and `TT_KEY` from `TT_RELAY` and `TT_KEY`, or from
`~/tt-relay-keys.txt`.

## Run it locally

```sh
cd server
TT_KEY=some-long-local-key-123 TT_AW_COMMAND="aw-server --host 127.0.0.1 --port 5600" python -m ttserver
```

It listens on `:8080` (`PORT` changes it). With an ActivityWatch already
running on 5600, leave out `TT_AW_COMMAND`.

| Variable | Default | |
| --- | --- | --- |
| `TT_KEY` | (required) | At least 16 characters. Opens everything. |
| `TT_INGEST_KEY` | | Optional, at least 16 characters. Upload endpoints only. |
| `TT_DATA` | `data` | Folder for `tt.db` (the raw lines). |
| `PORT` | `8080` | |
| `TT_AW_URL` | `http://127.0.0.1:5600` | ActivityWatch's server. |
| `TT_AW_COMMAND` | | Starts that server and restarts it if it exits. |
| `TT_AW_API_KEY` | | If ActivityWatch itself has `[auth] api_key` set. |
| `TT_DASHBOARD` | `dashboard/dist` | The built dashboard served at `/app/`. |
| `TT_LLM_GROQ_KEY`, `TT_LLM_CEREBRAS_KEY`, `TT_LLM_GEMINI_KEY`, `TT_LLM_MISTRAL_KEY`, `TT_LLM_OPENROUTER_KEY` | | Free-tier keys for block labels, tried in this order. |
| `TT_LLM_<NAME>_MODEL` | (below) | A different model for that provider (`GROQ`, `LLM7`, ...). |
| `TT_LLM_LLM7_KEY` | | Optional free LLM7 token, for higher limits. |
| `TT_LLM_KEYLESS` | `0` | `1` also sends block titles to the keyless services. |

## Block labels

The dashboard's timeline groups the day into blocks and names each one
("Writing in Overleaf", "CAD in SolidWorks", "Andor on Disney+"). It posts each
block of five minutes or more (its top six apps and sites, with one window or
page title each) to `/tt/labels`. The relay (`ttserver/labels.py`) asks a
model for up to 20 blocks per call and keeps the answers in `labels.db` next
to `tt.db`, by a coarse digest of the block (main subjects in order, titles
letters only), so a live block that keeps growing isn't asked about again.
The dashboard also keeps them in the browser. Any block no provider labels
keeps the dashboard's own label.

All providers are free tiers with OpenAI-compatible chat endpoints, called
with the standard library. They're tried in order; one that fails, times out
(20 s) or rate-limits (then skipped for a minute) passes its blocks on to the
next. The list they come from is
[awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis);
limits as of October 2026.

| Provider | Model | Key | Free limits | Why |
| --- | --- | --- | --- | --- |
| Groq | `openai/gpt-oss-20b` | `TT_LLM_GROQ_KEY` ([console.groq.com/keys](https://console.groq.com/keys)) | 30 req/min, 1,000/day | Fastest, most generous; the one to set up. |
| Cerebras | `gpt-oss-120b` | `TT_LLM_CEREBRAS_KEY` ([cloud.cerebras.ai](https://cloud.cerebras.ai)) | about 30 req/min, 14,400/day | Also very fast. Not on the list any more; check it's still free. |
| Google Gemini | `gemini-2.5-flash-lite` | `TT_LLM_GEMINI_KEY` ([aistudio.google.com](https://aistudio.google.com/app/apikey)) | per-account quotas in AI Studio | Reliable. Free-tier prompts may be used by Google. |
| Mistral | `ministral-8b-latest` | `TT_LLM_MISTRAL_KEY` ([console.mistral.ai](https://console.mistral.ai/api-keys)) | about 1 req/s | Free mode may train on prompts unless you opt out. |
| OpenRouter | `openrouter/free` | `TT_LLM_OPENROUTER_KEY` ([openrouter.ai/keys](https://openrouter.ai/keys)) | 20 req/min, 50/day | Routes to whichever free model is up. |
| LLM7.io | `gpt-oss:20b` | none (optional `TT_LLM_LLM7_KEY`) | with a free token 60 req/min, 250/hour | No sign-up. |
| Kilo Code | `kilo-auto/free` | none | 200 req/hour per IP | No sign-up; may route to providers that log prompts. |
| OVHcloud AI Endpoints | `gpt-oss-20b` | none | 2 req/min per IP and model | No sign-up, EU-hosted; last resort. |

The keyless ones are off unless `TT_LLM_KEYLESS=1`: nobody signs up, so it's
unknown who keeps the window titles and site names they're sent. Most free
tiers may also log or train on prompts. With no key and no keyless providers,
the dashboard's own labels are used. On Fly (Gabe's relay uses Gemini):

```sh
fly secrets set TT_LLM_GROQ_KEY=... TT_LLM_GEMINI_KEY=...   # any of them, all optional
fly secrets set TT_LLM_KEYLESS=1                            # also the no-sign-up services
```

The relay prints the chain it will use when it starts.

## Tests

Standard library only, no installs:

```sh
cd server
python -m unittest discover -s tests
```

The end-to-end test starts a real aw-server-rust; point `AW_SERVER` at the
binary (e.g. the `aw-server-rust` from ActivityWatch's release zip), or it's
skipped.
