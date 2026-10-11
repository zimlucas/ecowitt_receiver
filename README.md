# Ecowitt Receiver

Pulls live data from the Ecowitt Cloud API and re-posts it to **Windy**,
**Weather Underground** and **Windguru** every 5 minutes, with a static
dashboard that shows the current conditions and whether each upload is
succeeding. Runs entirely on **Netlify** (a scheduled function + Netlify Blobs);
no server to keep alive.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Scheduled poller | `netlify/functions/poll.mjs` | Runs every 5 min: reads the station, posts to all three services, stores status in Netlify Blobs. |
| Status API | `netlify/functions/status.mjs` | Serves the latest reading + upload results to the dashboard (`/api/status`). |
| Dashboard | `index.html` | Static page that polls `/api/status` and shows the monitors. |
| Shared code | `lib/` | Config, unit conversion, Ecowitt client, the three posters. |
| Backfill | `backfill.py` | One-off local script to push historical data (see below). |

## Deploy to Netlify

1. Push this repo to GitHub (already wired to `origin`).
2. In Netlify: **Add new site → Import an existing project →** pick this repo.
   `netlify.toml` is auto-detected; `@netlify/blobs` installs during build.
3. Add the environment variables below under
   **Site configuration → Environment variables** (see `.env.example`).
4. **Publish the production deploy.** Scheduled functions only run on the
   published production site — not on deploy previews.

The first post appears a few minutes after publishing. Open the site URL to
watch the dashboard.

### Required environment variables

| Variable | Notes |
| --- | --- |
| `ECOWITT_APPLICATION_KEY` | from ecowitt.net |
| `ECOWITT_API_KEY` | from ecowitt.net |
| `ECOWITT_MAC` | station MAC (device identifier) |
| `WINDY_STATION_ID` | stations.windy.com → My Stations → station ID |
| `WINDY_STATION_PASSWORD` | same page → station password (secret) |
| `WU_PASSWORD` | Weather Underground key/password |
| `WG_PASSWORD` | Windguru password |

`WU_ID`, `WG_UID` and the `STATION_*` values have defaults in `lib/config.mjs`;
override them with env vars if needed. **No secrets are committed** — set them in
Netlify (and locally in a gitignored `.env`).

### Windy (Stations API v2)

Uploads use `GET https://stations.windy.com/api/v2/observation/update?id=<station ID>`
with the station password as `Authorization: Bearer`. The account-wide API key
(`WINDY_API_KEY`) is **not** accepted for uploads and is no longer used; the
legacy `/pws/update/<API_KEY>` endpoint shuts down at the end of 2026.
Windy accepts at most one observation per 5 minutes per station. Pressure is
stored but only displayed for professional stations.

The functions run on Node 22 (pinned in `netlify.toml`).

## Free tier

The poller runs every 5 minutes ≈ 8,640 invocations/month, well within
Netlify's free tier (125k requests, 100 runtime-hours). The dashboard's
`/api/status` calls only happen while a browser tab is open.

## Historical backfill

The station has months of history in the Ecowitt Cloud. Re-post it locally:

```powershell
py -m pip install -r requirements.txt
# credentials are read from .env (copy .env.example -> .env)
py backfill.py --start 2025-09-01 --end 2026-06-18 --targets wu
```

- **Weather Underground** accepts months of backdated observations — full
  history can be restored.
- **Windy** and **Windguru** reject anything older than ~2 hours, so they
  cannot be backfilled (only live data going forward).

## Local files (not deployed)

- `app.py`, `Procfile` — the old Railway Flask app, kept for reference.
- `local_monitor.py` — the original local poller (gitignored).
