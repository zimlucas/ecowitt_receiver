// HTTP function: one chunk of the station history (see lib/chunks.mjs).
//
// Query: ?level=5min|30min|4hour|1day&chunk=<unix seconds>[&v=<n>]
// `chunk` is rounded down to a chunk boundary; omitted = the latest chunk.
// `v` is a client-side cache-busting version, ignored here.
//
// The dashboard loads only the chunks around what is on screen, so it can pan
// across the whole history. Final chunks never change: they are served with
// long browser/CDN cache headers, so revisiting them costs no function call.
import { LEVELS, SINCE, alignChunk, chunkSize, loadChunk } from "../../lib/chunks.mjs";
import { config } from "../../lib/config.mjs";

function respond(status, body, cache) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cache.browser,
  };
  if (cache.cdn) {
    headers["Netlify-CDN-Cache-Control"] = cache.cdn;
    headers["Netlify-Vary"] = "query=level|chunk|v";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const NO_CACHE = { browser: "no-store" };
const FINAL_CACHE = { browser: "public, max-age=604800, immutable", cdn: "public, durable, max-age=31536000" };
const SHORT_CACHE = (ttl) => ({ browser: "no-store", cdn: `public, durable, max-age=${ttl}` });

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const level = LEVELS[params.get("level")] ? params.get("level") : "5min";
  const now = Math.floor(Date.now() / 1000);
  const asked = Number(params.get("chunk"));
  const start = alignChunk(level, params.has("chunk") && Number.isFinite(asked) ? asked : now);

  const meta = {
    level,
    chunk: start,
    size: chunkSize(level),
    server_time: now,
    since: SINCE,
    station: { lat: config.station.lat, lon: config.station.lon },
  };

  try {
    // Ecowitt's burst limit clears within a second or two: wait and retry once
    // before making the client back off.
    const load = () => loadChunk(level, start, now);
    const { points, final, source } = await load().catch(async (err) => {
      if (!/too frequent|upper limit/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      return load();
    });
    const cache = source === "stale" ? NO_CACHE
      : final && (points.length || source === "none") ? FINAL_CACHE
      : SHORT_CACHE(final ? 3600 : LEVELS[level].liveTtl);
    return respond(200, { ...meta, final, stale: source === "stale", points }, cache);
  } catch (err) {
    // Still throttled ("Operation too frequent", "The number of interface
    // accesses reached the upper limit") or Ecowitt down: the client retries.
    console.error(`history ${level}:${start}:`, String(err));
    return respond(503, { ...meta, final: false, points: [], error: String(err.message || err) }, NO_CACHE);
  }
};
