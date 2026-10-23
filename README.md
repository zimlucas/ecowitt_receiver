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
| History API | `netlify/functions/history.mjs` | One chunk of history per request for the chart (`/api/history?level=&chunk=`). |
| Archiver | `netlify/functions/archive.mjs` | Hourly: saves every 5-min day (and 30-min week) into Blobs before Ecowitt drops it. |
| Backfill | `netlify/functions/backfill-background.mjs` | Re-posts recent history to Weather Underground (see below). |
| Shared code | `lib/` | Config, unit conversion, Ecowitt client, history chunks, the three posters, storage. |
| Local dev | `dev/server.mjs` | `npm run dev`: everything locally, uploads in dry-run. |

### History and the chart

History is stored per resolution in fixed, aligned chunks (`lib/chunks.mjs`):
5-min data in 1-day chunks, 30-min in weeks, 4-hour in months, daily in
quarters. A chunk whose period has closed never changes, so it is kept in the
`history` Blobs store forever and served with long browser/CDN cache headers;
only the latest chunk is re-read from Ecowitt. The chart loads just the chunks
around what is on screen, so it can be dragged across the whole history (since
`STATION_SINCE`) in any view.

Below the chart, the wind statistics (wind rose and wind by hour of day) load
every 30-min week since `STATION_SINCE` and compute everything in the browser,
filtered by a minimum wind and by month. Only daylight samples count, and a day
counts only if the wind stayed at or above the minimum for 1 h in a row.

Ecowitt keeps 5-minute data only ~90 days (older days come back at 30-min
resolution), so the archiver copies each day into Blobs while it still exists.
The archive keeps all fields (wind, direction, solar, UV, temperature, dew
point, humidity, pressure): about 10-15 MB per year.

The sky emoji (24h and week views) are estimated in the browser from solar
irradiance: measured vs. clear-sky irradiance for the sun position, scaled per
hour by the station's own best values of the previous 3 weeks (it is partly
shaded in late afternoon), averaged per period. Night is shaded in the plot.

Under the measured chart, a second chart with the same layout shows the
**ECMWF IFS 9 km** forecast for the station (wind and gust at 10 m, cloud
cover), from Open-Meteo's historical-forecast API: for each hour, the most
recent model run that covered it. The browser fetches it directly (no key, no
function call): the last 10 days first, then the whole history, refreshed
hourly. Both charts pan/zoom together and share the Y axis; aggregated views
use mean wind and max gust like the station history. The forecast sky emoji
come from cloud cover (< 20% open, < 50% few clouds, < 80% broken, otherwise
overcast; heavy overcast when low clouds ≥ 80%).

## Run locally (test before deploying)

```powershell
npm run dev     # -> http://localhost:8888
```

`dev/server.mjs` runs the dashboard and the functions locally with real Ecowitt
data (credentials from `.env`), restarting on code changes. State goes to
`.dev-data/` instead of Netlify Blobs, and the scheduled functions run on
their schedules with the poller in **dry-run**: nothing is posted to Windy /
WU / Windguru (set `DRY_RUN=0` in `.env` to post for real). No Netlify CLI or
`npm install` needed. If port 8888 is busy, the next free port is used.

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

Netlify's current free plan is credit-based: 300 credits/month, and the site is
**paused** when they run out. Rough budget: compute is 10 credits per GB-hour
(the 5-min poller is the main consumer, roughly 60 credits/month), web requests
2 credits per 10k, and **every production deploy costs 15 credits** — test
locally with `npm run dev` and deploy in batches. The chart is cheap: past
chunks come from browser/CDN caches without running a function. Check actual
usage under **Usage & billing**.

## Historical backfill

The dashboard's "Reenviar" button (`netlify/functions/backfill-background.mjs`)
re-posts up to 7 days of Ecowitt history to **Weather Underground**, which
accepts backdated observations. **Windy** and **Windguru** reject anything
older than ~2 hours, so they cannot be backfilled (only live data going forward).
