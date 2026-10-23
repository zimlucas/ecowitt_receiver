// The whole closed 30-min history in one compact blob.
//
// The dashboard's statistics and hour-by-hour table need every 30-min week
// since the station's first day; asking for them one by one cost ~45 requests
// and ~200 KB compressed. The bundle holds every *final* week up to `upto`
// (the start of the last final week) as columns of small integers, so it is
// one request of ~50 KB. A bundle never changes once built (its weeks are
// final), so it is cached for good; a new one appears each week. The current
// week is still read as a normal chunk.
//
// Format: { v, level, from, upto, size, ts0, dt[], w[], g[], d[], s[] }
//   ts = ts0 + running sum of dt; w/g = wind/gust in tenths of a knot;
//   d = direction (deg); s = solar (W/m2); null where missing.
import { SINCE, alignChunk, chunkSize, historyStore, isFinal, loadChunk } from "./chunks.mjs";

const LEVEL = "30min";
const VERSION = 1;
const key = (upto) => `bundle:${LEVEL}:${upto}`;

// Start of the last final 30-min week at `now`.
export function bundleUpto(now) {
  let s = alignChunk(LEVEL, now);
  while (!isFinal(LEVEL, s, now)) s -= chunkSize(LEVEL);
  return s;
}

export const validUpto = (upto, now) =>
  Number.isInteger(upto) && upto === alignChunk(LEVEL, upto) && isFinal(LEVEL, upto, now);

const tenths = (v) => (v == null ? null : Math.round(v * 10));
const whole = (v) => (v == null ? null : Math.round(v));

function encode(points, from, upto) {
  const out = { v: VERSION, level: LEVEL, from, upto, size: chunkSize(LEVEL), ts0: points[0]?.ts ?? from, dt: [], w: [], g: [], d: [], s: [] };
  let prev = out.ts0;
  for (const p of points) {
    out.dt.push(p.ts - prev);
    prev = p.ts;
    out.w.push(tenths(p.wind_knots));
    out.g.push(tenths(p.gust_knots));
    out.d.push(whole(p.dir));
    out.s.push(whole(p.solar));
  }
  return out;
}

// The bundle ending at `upto`: from the store, or built from the stored weeks
// (which the archiver keeps) and saved. Throws if a week can't be read.
export async function loadBundle(upto, now = Math.floor(Date.now() / 1000), store = historyStore()) {
  const hit = await store.get(key(upto), { type: "json" }).catch(() => null);
  if (hit?.v === VERSION) return hit;
  const from = alignChunk(LEVEL, SINCE);
  const byTs = new Map(); // weeks share their edge point
  for (let s = from; s <= upto; s += chunkSize(LEVEL)) {
    const { points } = await loadChunk(LEVEL, s, now, store);
    for (const p of points) byTs.set(p.ts, p);
  }
  const bundle = encode([...byTs.values()].sort((a, b) => a.ts - b.ts), from, upto);
  await store.setJSON(key(upto), bundle);
  return bundle;
}
