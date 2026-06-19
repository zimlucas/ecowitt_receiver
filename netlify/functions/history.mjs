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
import { fetchHistory, windSeriesFromHistory } from "../../lib/ecowitt.mjs";

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const DAY = 86400;
const LEVELS = {
  "5min": { extentDays: 7, chunkDays: 1, cycle: "5min" },
  "30min": { extentDays: 56, chunkDays: 7, cycle: "30min" },
  "4hour": { extentDays: 180, chunkDays: 30, cycle: "4hour" },
  "1day": { extentDays: 365, chunkDays: 90, cycle: "1day" },
};

export default async (req) => {
  const level = new URL(req.url).searchParams.get("level") || "5min";
  const cfg = LEVELS[level] || LEVELS["5min"];

  const end = Math.floor(Date.now() / 1000);
  const start = end - cfg.extentDays * DAY;

  // Build equal-sized chunks so every chunk yields the same Ecowitt resolution.
  const chunks = [];
  for (let s = start; s < end; s += cfg.chunkDays * DAY) {
    chunks.push([s, Math.min(s + cfg.chunkDays * DAY, end)]);
  }

  // Fetch sequentially with a small delay: the Ecowitt API rejects bursts with
  // "Operation too frequent", so parallel requests would drop most chunks.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let points = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const [s, e] = chunks[i];
      try {
        const data = await fetchHistory(s, e, cfg.cycle, "wind");
        points = points.concat(windSeriesFromHistory(data));
      } catch (err) {
        // One bad chunk shouldn't void the whole series.
      }
      if (i < chunks.length - 1) await sleep(250);
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ level, points: [], error: String(err) }),
      { status: 200, headers: HEADERS },
    );
  }

  // De-duplicate by timestamp and sort ascending.
  const byTs = new Map(points.map((p) => [p.ts, p]));
  points = [...byTs.values()].sort((a, b) => a.ts - b.ts);

  const body = { level, server_time: end, points };
  return new Response(JSON.stringify(body), { status: 200, headers: HEADERS });
};
