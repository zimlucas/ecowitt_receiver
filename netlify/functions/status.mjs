// HTTP function. Returns the latest reading, the last post-cycle result and a
// short history log as JSON for the dashboard. Read-only.
//
// The data only changes when the poller runs (every 5 min), so the CDN keeps
// the response until shortly after the next run: every open dashboard shares
// one function call per cycle. `?fresh=<anything>` skips that cached copy
// (the dashboard uses it while a backfill is running).
import { CYCLE_SEC, readState, stateStore } from "../../lib/state.mjs";
import { config } from "../../lib/config.mjs";

const SETTLE_SEC = 20; // after a cycle mark, by when the poller has usually stored its run
const RETRY_SEC = 15; // CDN lifetime while this cycle's run is still pending

// Seconds the CDN may keep this response.
function cdnMaxAge(state, now) {
  const mark = Math.floor(now / CYCLE_SEC) * CYCLE_SEC;
  const at = state.latest?.at ? Date.parse(state.latest.at) / 1000 : 0;
  if (at < mark) return RETRY_SEC; // this cycle's reading hasn't landed yet
  return Math.max(RETRY_SEC, Math.round(mark + CYCLE_SEC + SETTLE_SEC - now));
}

export default async () => {
  const store = stateStore();
  const [state, backfill] = await Promise.all([readState(store), store.get("backfill_status", { type: "json" })]);
  const now = Date.now() / 1000;

  const body = {
    server_time: new Date().toISOString(),
    cycle_sec: CYCLE_SEC,
    station: {
      name: config.station.name,
      lat: config.station.lat,
      lon: config.station.lon,
    },
    latest: state.latest || null,
    status: state.status || null,
    log: state.log || [],
    backfill: backfill || null,
    recent: state.recent || [], // live wind readings of the last ~2 h, for the chart's right edge
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": `public, durable, max-age=${cdnMaxAge(state, now)}`,
      "Netlify-Vary": "query=fresh",
    },
  });
};
