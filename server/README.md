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
| `GET /tt/health` | No key needed. |
| everything else | The ActivityWatch web UI and API, behind basic auth. |

## Deploy on Fly.io (least upkeep)

Fly runs the container on a small always-on machine with a disk, and gives it
an HTTPS address. It costs about $2–3 a month (a shared-cpu-1x 256 MB machine
plus a 1 GB volume).

1. Install `flyctl` and sign up: <https://fly.io/docs/flyctl/install/>, then
   `fly auth signup` (or `fly auth login`).
2. Pick an app name and put it in `server/fly.toml` (`app = "..."`). The relay
   will live at `https://<name>.fly.dev`.
3. From the `server/` folder:
   ```sh
   fly apps create <name>
   fly volumes create tt_data --size 1 --region lax --app <name>   # or a region near you
   KEY=$(openssl rand -hex 24); INGEST=$(openssl rand -hex 24)
   echo "TT_KEY=$KEY  TT_INGEST_KEY=$INGEST"   # save both: fly won't show them again
   fly secrets set TT_KEY=$KEY TT_INGEST_KEY=$INGEST --app <name>
   fly deploy
   ```
   On Windows, generate each key with
   `python -c "import secrets; print(secrets.token_hex(24))"` and paste it in.
4. Check it: open `https://<name>.fly.dev/tt/health`, then
   `https://<name>.fly.dev/` and sign in with any user name and the key as
   password. That is the ActivityWatch web UI.

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

## Tests

Standard library only, no installs:

```sh
cd server
python -m unittest discover -s tests
```

The end-to-end test starts a real aw-server-rust; point `AW_SERVER` at the
binary (e.g. the `aw-server-rust` from ActivityWatch's release zip), or it's
skipped.
