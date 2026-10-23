// History chunks: the unit of storage for the chart and the archive.
//
// History is split per resolution level into fixed chunks aligned to multiples
// of the chunk size since the Unix epoch:
//   5min  -> 1-day chunks   (Ecowitt keeps 5-min data only ~90 days; asked for
//                            older days it silently returns 30-min data)
//   30min -> 7-day chunks   (also bundled whole, see lib/bundle.mjs)
// The dashboard computes its 4-hour and daily views from the 30-min data.
// A chunk is "final" once its last aggregation period has closed; it never
// changes again and is kept in the "history" store forever. That store is also
// the 5-min archive: netlify/functions/archive.mjs saves every 5-min day before
// Ecowitt drops it. Only the still-growing latest chunk is re-read from
// Ecowitt, at most once per `liveTtl`.
import { fetchHistory, windSeriesFromHistory } from "./ecowitt.mjs";
import { getStore } from "./store.mjs";
import { config } from "./config.mjs";

export const DAY = 86400;
const ALL_FIELDS = "indoor,wind,pressure,solar_and_uvi";

export const LEVELS = {
  "5min": { chunkDays: 1, res: 300, liveTtl: 300 }, // points arrive ~10 min late anyway
  "30min": { chunkDays: 7, res: 1800, liveTtl: 300 },
};

// First day with data; nothing is fetched before it.
export const SINCE = Math.floor(Date.parse(`${config.station.since}T00:00:00Z`) / 1000) || 0;

const EMPTY_RETRY = DAY; // re-check a past chunk that came back empty after a day

export const chunkSize = (level) => LEVELS[level].chunkDays * DAY;
export const alignChunk = (level, sec) => Math.floor(sec / chunkSize(level)) * chunkSize(level);
export const chunkKey = (level, start) => `${level}:${start}`;
export const isFinal = (level, start, now) => start + chunkSize(level) + LEVELS[level].res + 3600 <= now;

export const historyStore = () => getStore({ name: "history" });

// Returns { points, final, source } where source is "store" | "ecowitt" |
// "stale" | "none". Throws when Ecowitt fails and there is nothing to fall back on.
export async function loadChunk(level, start, now = Math.floor(Date.now() / 1000), store = historyStore()) {
  const end = start + chunkSize(level);
  const final = isFinal(level, start, now);
  if (end <= SINCE || start > now) return { points: [], final: true, source: "none" };

  const key = final ? chunkKey(level, start) : `${chunkKey(level, start)}:live`;
  const hit = await store.get(key, { type: "json" }).catch(() => null);
  if (final && Array.isArray(hit)) return { points: hit, final, source: "store" };
  if (final && hit?.empty && now - hit.at < EMPTY_RETRY) return { points: [], final, source: "store" };
  if (!final && hit?.points && now - hit.at < LEVELS[level].liveTtl) {
    return { points: hit.points, final, source: "store" };
  }

  try {
    const data = await fetchHistory(start, Math.min(end, now), level, ALL_FIELDS);
    const points = windSeriesFromHistory(data).filter((p) => p.ts >= start && p.ts <= end);
    const save = (value) => store.setJSON(key, value).catch((e) => console.error(`store ${key}:`, String(e)));
    if (final) await save(points.length ? points : { empty: true, at: now });
    else if (points.length) await save({ at: now, points });
    return { points, final, source: "ecowitt" };
  } catch (err) {
    if (!final && hit?.points) return { points: hit.points, final, source: "stale" };
    throw err;
  }
}
