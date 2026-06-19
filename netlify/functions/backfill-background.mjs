// Background function: re-posts recent history to Weather Underground.
//
// Triggered on demand from the dashboard "Reenviar histórico" button. Netlify
// background functions (the "-background" suffix) may run up to 15 minutes and
// return 202 immediately, so the dashboard polls /api/status for progress.
//
// Only Weather Underground is backfilled: Windy rejects data older than 60 min
// and Windguru older than ~2 h. For months of history, use backfill.py locally.
import { getStore } from "@netlify/blobs";
import { fetchHistory, samplesFromHistory } from "../../lib/ecowitt.mjs";
import { postWunderground } from "../../lib/posters.mjs";

const DAY = 86400;
const STALE_MS = 16 * 60 * 1000; // a run older than this is considered dead
const MAX_DAYS = 7; // safety cap so a single run stays within the time limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const store = getStore({ name: "ecowitt", consistency: "strong" });

  // Guard: refuse to start a second run while one is genuinely in progress.
  const prev = await store.get("backfill_status", { type: "json" });
  if (prev?.running && prev.started_at && Date.now() - new Date(prev.started_at).getTime() < STALE_MS) {
    return new Response("already running", { status: 202 });
  }

  let days = Number(new URL(req.url).searchParams.get("days") || "2");
  if (!Number.isFinite(days) || days < 1) days = 2;
  days = Math.min(days, MAX_DAYS);

  const end = Math.floor(Date.now() / 1000);
  const start = end - days * DAY;

  const state = {
    running: true,
    started_at: new Date().toISOString(),
    finished_at: null,
    days,
    target: "wunderground",
    total: 0,
    posted: 0,
    failed: 0,
    error: null,
  };
  await store.setJSON("backfill_status", state);

  try {
    // Walk day by day (5-minute history is limited to ~24h per request).
    for (let dayStart = start; dayStart < end; dayStart += DAY) {
      const dayEnd = Math.min(dayStart + DAY, end);
      const data = await fetchHistory(dayStart, dayEnd, "5min", "indoor,wind,pressure,solar_and_uvi");
      const samples = samplesFromHistory(data);
      state.total += samples.length;

      for (const sample of samples) {
        const res = await postWunderground(sample, sample.ts);
        if (res.ok) state.posted += 1;
        else state.failed += 1;
        await sleep(120); // be gentle with the WU endpoint
      }
      await store.setJSON("backfill_status", { ...state });
    }
  } catch (err) {
    state.error = String(err);
  }

  state.running = false;
  state.finished_at = new Date().toISOString();
  await store.setJSON("backfill_status", state);

  return new Response("done", { status: 200 });
};
