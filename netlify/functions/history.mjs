// HTTP function: returns a wind time series (knots) at a fixed resolution.
//
// Query: ?level=5min | 30min | 4hour | 1day
// Each level is fetched in equal-sized chunks across its whole extent so the
// resolution is UNIFORM over the entire period (no denser points near "now").
// The frontend uses these as level-of-detail tiers and switches between them on
// zoom/pan:
//   5min  -> 7 days   (view 24h, pan back to a week)
//   30min -> 56 days  (view 1 week, pan back to 8 weeks)
//   4hour -> 180 days (view 1 month, pan back to ~6 months)
//   1day  -> 365 days (view 1 year)
//
// Chunks are aligned to fixed boundaries (multiples of the chunk size since the
// Unix epoch), so every chunk that ended in the past never changes: those are
// cached in the "history" store and only the most recent chunk(s) hit the
// Ecowitt API. This keeps every level fast and avoids Ecowitt's
// "Operation too frequent" throttling.
//
// The 5min and 30min levels also carry solar irradiance, used by the dashboard
// to estimate the sky condition.
import { fetchHistory, windSeriesFromHistory } from "../../lib/ecowitt.mjs";
import { getStore } from "../../lib/store.mjs";
import { config } from "../../lib/config.mjs";

const DAY = 86400;
// liveTtl: how long the still-growing latest chunk is reused before re-fetching.
const LEVELS = {
  "5min": { extentDays: 7, chunkDays: 1, res: 300, callBack: "wind,solar_and_uvi", liveTtl: 60, cdnMaxAge: 60 },
  "30min": { extentDays: 56, chunkDays: 7, res: 1800, callBack: "wind,solar_and_uvi", liveTtl: 300, cdnMaxAge: 300 },
  "4hour": { extentDays: 180, chunkDays: 30, res: 14400, callBack: "wind", liveTtl: 900, cdnMaxAge: 1800 },
  "1day": { extentDays: 365, chunkDays: 90, res: 86400, callBack: "wind", liveTtl: 1800, cdnMaxAge: 3600 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(cfg, partial) {
  const h = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  // Let Netlify's CDN serve repeat requests; never cache an incomplete series.
  if (!partial) {
    h["Netlify-CDN-Cache-Control"] =
      `public, durable, max-age=${cfg.cdnMaxAge}, stale-while-revalidate=${cfg.cdnMaxAge}`;
    h["Netlify-Vary"] = "query=level";
  }
  return h;
}

export default async (req) => {
  const requested = new URL(req.url).searchParams.get("level") || "5min";
  const level = LEVELS[requested] ? requested : "5min";
  const cfg = LEVELS[level];

  const end = Math.floor(Date.now() / 1000);
  const start = end - cfg.extentDays * DAY;
  const size = cfg.chunkDays * DAY;

  // A chunk is final once its last aggregation period has closed.
  const chunks = [];
  for (let s = Math.floor(start / size) * size; s < end; s += size) {
    chunks.push({ s, e: s + size, final: s + size + cfg.res + 3600 <= end, key: `${level}:${s}` });
  }

  // Final chunks are stored as a plain array of points; the growing latest
  // chunk as { at, points } under "<key>:live".
  const store = getStore({ name: "history" });
  const cached = await Promise.all(
    chunks.map((c) => store.get(c.final ? c.key : `${c.key}:live`, { type: "json" }).catch(() => null)),
  );

  let points = [];
  let failed = 0;
  let fetched = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const hit = cached[i];
    if (c.final && Array.isArray(hit)) {
      points = points.concat(hit);
      continue;
    }
    if (!c.final && hit?.points && end - hit.at < cfg.liveTtl) {
      points = points.concat(hit.points);
      continue;
    }
    // Space out live calls: Ecowitt rejects bursts ("Operation too frequent",
    // "The number of interface accesses reached the upper limit").
    if (fetched++ > 0) await sleep(250);
    try {
      const data = await fetchHistory(c.s, Math.min(c.e, end), level, cfg.callBack);
      const series = windSeriesFromHistory(data);
      points = points.concat(series);
      if (series.length) {
        const value = c.final ? series : { at: end, points: series };
        await store.setJSON(c.final ? c.key : `${c.key}:live`, value).catch(() => {});
      }
    } catch (err) {
      console.error(`history ${c.key}:`, String(err));
      // Fall back to an older copy of the live chunk rather than leaving a hole.
      if (!c.final && hit?.points) points = points.concat(hit.points);
      else failed += 1;
    }
  }

  // De-duplicate by timestamp, keep the requested extent, sort ascending.
  const byTs = new Map(points.filter((p) => p.ts >= start).map((p) => [p.ts, p]));
  points = [...byTs.values()].sort((a, b) => a.ts - b.ts);

  const partial = failed > 0;
  const body = {
    level,
    server_time: end,
    station: { lat: config.station.lat, lon: config.station.lon },
    partial,
    points,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: headers(cfg, partial) });
};
