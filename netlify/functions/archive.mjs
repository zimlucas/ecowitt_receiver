// Scheduled function (hourly): keeps the history archive complete.
//
// Ecowitt keeps 5-minute data only ~90 days. Every final 5-min day still
// available there is copied into the "history" store (the same chunks the
// chart reads, see lib/chunks.mjs), oldest first because those expire first.
// The 30-min weeks since the station's first day are archived too, as cheap
// insurance against Ecowitt shortening that retention.
//
// Each run archives a few chunks within a time budget (scheduled functions may
// run 30 s), so the initial catch-up spreads over a few hours and afterwards
// each run has at most one new day to save.
import { DAY, SINCE, alignChunk, chunkKey, chunkSize, historyStore, isFinal, loadChunk } from "../../lib/chunks.mjs";
import { bundleUpto, loadBundle } from "../../lib/bundle.mjs";

const FIVE_MIN_DAYS = 88; // stay inside Ecowitt's ~90-day window
const BUDGET_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function missing(store, level, from, now) {
  const { blobs } = await store.list({ prefix: `${level}:` });
  const have = new Set(blobs.map((b) => b.key));
  const out = [];
  for (let s = alignChunk(level, from); isFinal(level, s, now); s += chunkSize(level)) {
    if (s + chunkSize(level) > SINCE && !have.has(chunkKey(level, s))) out.push([level, s]);
  }
  return out;
}

export default async () => {
  const started = Date.now();
  const now = Math.floor(started / 1000);
  const store = historyStore();
  const todo = [
    ...(await missing(store, "5min", Math.max(SINCE, now - FIVE_MIN_DAYS * DAY), now)),
    ...(await missing(store, "30min", SINCE, now)),
  ];

  let saved = 0;
  let failed = 0;
  for (const [level, start] of todo) {
    if (Date.now() - started > BUDGET_MS) break;
    if (saved + failed > 0) await sleep(1200); // Ecowitt throttles bursts
    try {
      await loadChunk(level, start, now, store);
      saved += 1;
    } catch (err) {
      failed += 1;
      console.error(`archive ${level}:${start}:`, String(err));
    }
  }
  // Build this week's 30-min bundle ahead of the first visitor (a no-op
  // once it exists; it needs every 30-min week archived first).
  let bundle = "";
  if (saved + failed === todo.length && Date.now() - started < BUDGET_MS) {
    try {
      await loadBundle(bundleUpto(now), now, store);
      bundle = ", bundle ok";
    } catch (err) {
      console.error("archive bundle:", String(err));
      bundle = ", bundle failed";
    }
  }
  const summary = `archived ${saved}, failed ${failed}, remaining ${todo.length - saved}${bundle}`;
  console.log(summary);
  return new Response(summary);
};

export const config = { schedule: "@hourly" };
