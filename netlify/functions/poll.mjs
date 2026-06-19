// Scheduled function.
//
// Runs every 5 minutes. Each run fetches one real-time reading from the station
// and posts it to Windy, Weather Underground and Windguru. Results are stored in
// Netlify Blobs for the dashboard.
import { getStore } from "@netlify/blobs";
import { fetchRealtime, sampleFromRealtime } from "../../lib/ecowitt.mjs";
import { aggregate, toDisplay } from "../../lib/convert.mjs";
import { postAll } from "../../lib/posters.mjs";

const LOG_LIMIT = 60; // how many post cycles to keep for the dashboard history strip

export default async () => {
  const store = getStore({ name: "ecowitt", consistency: "strong" });

  // 1. Fetch one live reading.
  const json = await fetchRealtime();
  const sample = json ? sampleFromRealtime(json) : null;
  if (!sample) return new Response("no data");

  // 2. Expose the freshest reading for the dashboard.
  await store.setJSON("latest", {
    at: new Date().toISOString(),
    ts: sample.ts,
    display: toDisplay(sample),
  });

  // 2b. Skip posting when the station has no new reading since last time. This
  // avoids posting duplicate timestamps (which Windy rejects) and redundant data.
  const lastTs = (await store.get("last_ts", { type: "json" }))?.ts;
  if (sample.ts && sample.ts === lastTs) {
    return new Response("no new reading");
  }

  // 3. Post the reading to all three services, using its real observation time.
  const { raw, display } = aggregate([sample]);
  const posts = await postAll(raw, sample.ts);

  const status = {
    updated_at: new Date().toISOString(),
    samples_used: 1,
    weather: display,
    posts,
  };
  await store.setJSON("status", status);
  await store.setJSON("last_ts", { ts: sample.ts });

  const log = (await store.get("log", { type: "json" })) || [];
  log.push({
    at: status.updated_at,
    windy: posts.windy.ok,
    wunderground: posts.wunderground.ok,
    windguru: posts.windguru.ok,
  });
  await store.setJSON("log", log.slice(-LOG_LIMIT));

  return new Response("ok");
};

// Run every 5 minutes (UTC).
export const config = { schedule: "*/5 * * * *" };
