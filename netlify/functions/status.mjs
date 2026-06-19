// HTTP function. Returns the latest reading, the last post-cycle result and a
// short history log as JSON for the dashboard. Read-only.
import { getStore } from "@netlify/blobs";
import { config } from "../../lib/config.mjs";

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export default async () => {
  const store = getStore({ name: "ecowitt", consistency: "strong" });

  const [latest, status, log, backfill] = await Promise.all([
    store.get("latest", { type: "json" }),
    store.get("status", { type: "json" }),
    store.get("log", { type: "json" }),
    store.get("backfill_status", { type: "json" }),
  ]);

  const body = {
    server_time: new Date().toISOString(),
    station: {
      name: config.station.name,
      lat: config.station.lat,
      lon: config.station.lon,
    },
    latest: latest || null,
    status: status || null,
    log: log || [],
    backfill: backfill || null,
  };

  return new Response(JSON.stringify(body), { headers: HEADERS });
};
