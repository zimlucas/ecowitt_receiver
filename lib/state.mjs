// The dashboard state kept by the poller: one blob ("state"), read once and
// written once per run, and read once by the status function.
//
//   latest   freshest reading { at, ts, display }
//   recent   live wind readings of the last ~2 h (the chart's right edge)
//   status   last post cycle { updated_at, weather, posts }
//   last_ts  observation time of the last reading posted
//   log      last post cycles, for the dashboard strips
import { getStore } from "./store.mjs";

export const stateStore = () => getStore({ name: "ecowitt", consistency: "strong" });

// The poller runs every 5 min (UTC, see netlify/functions/poll.mjs).
export const CYCLE_SEC = 300;

const LEGACY_KEYS = ["latest", "recent", "status", "last_ts", "log"];

export async function readState(store) {
  const state = await store.get("state", { type: "json" });
  if (state) return state;
  // Before the merge each part had its own key: pick them up once.
  const [latest, recent, status, lastTs, log] = await Promise.all(
    LEGACY_KEYS.map((key) => store.get(key, { type: "json" })),
  );
  return { latest, recent: recent || [], status, last_ts: lastTs?.ts ?? null, log: log || [] };
}
