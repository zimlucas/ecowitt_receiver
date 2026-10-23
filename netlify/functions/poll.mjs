// Scheduled function.
//
// Runs every 5 minutes. Each run fetches one real-time reading from the station
// and posts it to Windy, Weather Underground and Windguru. The dashboard state
// (lib/state.mjs) is one blob: read while the station is being fetched, written
// once at the end, so storage adds a single round trip to the run.
import { readState, stateStore } from "../../lib/state.mjs";
import { fetchRealtime, sampleFromRealtime } from "../../lib/ecowitt.mjs";
import { aggregate, toDisplay } from "../../lib/convert.mjs";
import { postAll } from "../../lib/posters.mjs";

const LOG_LIMIT = 60; // how many post cycles to keep for the dashboard history strip
const RECENT_SEC = 2 * 3600; // live readings kept for the chart's right edge

export default async () => {
  const store = stateStore();
  const [json, state] = await Promise.all([fetchRealtime(), readState(store)]);

  // 1. One live reading.
  const sample = json ? sampleFromRealtime(json) : null;
  if (!sample) return new Response("no data");

  // 2. The freshest reading, for the dashboard.
  const live = toDisplay(sample);
  state.latest = { at: new Date().toISOString(), ts: sample.ts, display: live };

  // 2a. The last couple of hours of live wind readings: Ecowitt's history API
  // publishes each 5-min point ~10 min late, so the chart draws these at its
  // right edge until the history catches up.
  if (sample.ts && !state.recent.some((r) => r.ts === sample.ts)) {
    state.recent.push({ ts: sample.ts, wind_knots: live.wind_knots, gust_knots: live.gust_knots, dir: live.wind_direction });
    state.recent = state.recent.filter((r) => r.ts > sample.ts - RECENT_SEC);
  }

  // 3. Post it, unless the station has no new reading since last time: that
  // would post a duplicate timestamp (which Windy rejects) and redundant data.
  const fresh = !(sample.ts && sample.ts === state.last_ts);
  if (fresh) {
    const { raw, display } = aggregate([sample]);
    const posts = await postAll(raw, sample.ts);
    state.status = { updated_at: new Date().toISOString(), samples_used: 1, weather: display, posts };
    state.last_ts = sample.ts;
    state.log = [...(state.log || []), {
      at: state.status.updated_at,
      windy: posts.windy.ok,
      wunderground: posts.wunderground.ok,
      windguru: posts.windguru.ok,
    }].slice(-LOG_LIMIT);
  }

  await store.setJSON("state", state);
  return new Response(fresh ? "ok" : "no new reading");
};

// Run every 5 minutes (UTC).
export const config = { schedule: "*/5 * * * *" };
