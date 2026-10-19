// HTTP function. Returns the latest reading, the last post-cycle result and a
// short history log as JSON for the dashboard. Read-only.
import { getStore } from "../../lib/store.mjs";
import { config } from "../../lib/config.mjs";

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export default async () => {
  const store = getStore({ name: "ecowitt", consistency: "strong" });

  const [latest, status, log, backfill, recent] = await Promise.all([
    store.get("latest", { type: "json" }),
    store.get("status", { type: "json" }),
    store.get("log", { type: "json" }),
    store.get("backfill_status", { type: "json" }),
    store.get("recent", { type: "json" }),
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
    recent: recent || [], // live wind readings of the last ~2 h, for the chart's right edge
  };

  return new Response(JSON.stringify(body), { headers: HEADERS });
};
