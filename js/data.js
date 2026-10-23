// Status API, chart levels and history loading (chunks, derived 4-hour/daily chunks).
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

const API = "/api/status";

// Register the zoom plugin defensively (UMD usually auto-registers).
try {
  const zp = window.ChartZoom || window.chartjsPluginZoom || window["chartjs-plugin-zoom"];
  if (window.Chart && zp && !Chart.registry.plugins.get("zoom")) Chart.register(zp.default || zp);
} catch (e) {}

// `fresh` skips the CDN's copy (see netlify/functions/status.mjs).
async function getStatus(fresh = false) {
  const res = await fetch(fresh ? `${API}?fresh=${Date.now()}` : API, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Wind chart ----
// History arrives in fixed, aligned chunks per resolution level (see
// lib/chunks.mjs). The chart loads only the chunks around the visible window
// (one screen either side, nearest first), so it can pan across the whole
// station history at any zoom. Past chunks never change and are cached by
// the browser, the CDN and the server. Buttons set the window size (ending
// now); zooming switches level automatically by visible span.
const DAY = 86400;
const HOUR_MS = 3600 * 1000;
const LEVELS = {
  "5min": { res: 300, chunk: 1 * DAY },
  "30min": { res: 1800, chunk: 7 * DAY },
  "4hour": { res: 14400, chunk: 30 * DAY },
  "1day": { res: 86400, chunk: 90 * DAY },
};
const VIEW_SPAN = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "1y": 365 * DAY };
const LEVEL_BTN = { "5min": "24h", "30min": "7d", "4hour": "30d", "1day": "1y" };
const HISTORY_VERSION = 2; // bump when the chunk format changes (busts browser caches)
const SKY_BAND = 30; // px reserved above the plot for the sky-condition emoji
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const pad2 = (n) => String(n).padStart(2, "0");

let windChart = null;
let fcChart = null; // the forecast, same layout, window kept in sync with windChart
let currentLevel = "5min";
let clockOffset = 0; // server clock - local clock, seconds
let station = null; // { lat, lon }
let sinceSec = null; // first day of station history
let followNow = true; // keep the window's right edge at "now" as time passes
let viewSeq = 0; // the latest user action wins; slower, older loads are dropped
let dirByTs = new Map();
let liveTail = []; // live readings from /api/status, newer than the history so far
const LIVE_GAP_SEC = 240; // min. distance from the last history point to a live reading shown after it

const nowSec = () => Math.floor(Date.now() / 1000) + clockOffset;

// Pick the resolution level for a visible span (seconds). The thresholds sit
// just above each view so e.g. zooming into a single day jumps to 5-min data.
function levelForSpan(spanSec) {
  if (spanSec <= 1.5 * DAY) return "5min";
  if (spanSec <= 10 * DAY) return "30min";
  if (spanSec <= 45 * DAY) return "4hour";
  return "1day";
}

// ---- Chunk loading ----
const chunks = Object.fromEntries(Object.keys(LEVELS).map((l) => [l, new Map()])); // level -> start -> chunk
const jobs = new Map(); // "level:start" -> pending job
const queue = [];
let activeFetches = 0;
const MAX_FETCHES = 2; // Ecowitt throttles bursts; past chunks come from caches anyway
// How long a still-growing chunk is reused. Ecowitt publishes 5-min points
// ~10 min late and the chart's edge comes from the live readings, so
// re-reading today's 5-min chunk more often than every 5 min gains nothing.
const LIVE_TTL_MS = { "5min": 300e3, "30min": 300e3, "4hour": 900e3, "1day": 1800e3 };
const RETRY_MS = [2000, 5000, 12000];

const alignChunk = (level, sec) => Math.floor(sec / LEVELS[level].chunk) * LEVELS[level].chunk;

function chunkStarts(level, fromSec, toSec) {
  const size = LEVELS[level].chunk;
  const lo = Math.max(fromSec, sinceSec ?? -Infinity);
  const hi = Math.min(toSec, nowSec());
  const out = [];
  for (let s = alignChunk(level, lo); s <= hi; s += size) out.push(s);
  return out;
}

function chunkFresh(level, start) {
  const c = chunks[level].get(start);
  return !!c && (c.final || Date.now() - c.fetchedAt < LIVE_TTL_MS[level]);
}

// Queue a chunk; resolves when it has loaded (or finally failed). Lower
// priority values are fetched first.
function requestChunk(level, start, priority = 0) {
  if (chunkFresh(level, start)) return Promise.resolve(chunks[level].get(start));
  const key = `${level}:${start}`;
  let job = jobs.get(key);
  if (!job) {
    job = { key, level, start, priority, attempt: 0 };
    job.promise = new Promise((resolve) => { job.resolve = resolve; });
    jobs.set(key, job);
    // Derived levels take no download slot (they wait on 30-min ones that do).
    if (DERIVED.has(level)) {
      deriveChunk(job).catch(() => storeChunk(job, { points: [], final: false, failed: true, fetchedAt: Date.now() }));
      return job.promise;
    }
    queue.push(job);
  }
  job.priority = Math.min(job.priority, priority);
  pump();
  return job.promise;
}

function pump() {
  while (activeFetches < MAX_FETCHES && queue.length) {
    queue.sort((a, b) => a.priority - b.priority);
    const job = queue.shift();
    activeFetches += 1;
    fetchChunk(job).finally(() => { activeFetches -= 1; pump(); });
  }
  updateBusy();
}

function storeChunk(job, chunk) {
  chunks[job.level].set(job.start, chunk);
  jobs.delete(job.key);
  job.resolve(chunk);
  onChunkLoaded(job.level);
}

// 4-hour and daily chunks are computed here from the 30-min data (which
// the statistics load anyway): mean wind, max gust, mean direction and
// solar per UTC-aligned period, like Ecowitt's own aggregates.
const DERIVED = new Set(["4hour", "1day"]);

async function deriveChunk(job) {
  const { level, start } = job;
  const { res, chunk: size } = LEVELS[level];
  const weeks = await Promise.all(chunkStarts("30min", start, start + size - 1)
    .map((s) => requestChunk("30min", s, job.priority)));
  const bins = new Map();
  for (const c of weeks) {
    for (const p of c.points) {
      if (p.ts < start || p.ts >= start + size || p.wind_knots == null) continue;
      const ts = Math.floor(p.ts / res) * res;
      let b = bins.get(ts);
      if (!b) bins.set(ts, (b = { ts, n: 0, w: 0, g: null, u: 0, v: 0, ns: 0, s: 0 }));
      b.n += 1;
      b.w += p.wind_knots;
      if (p.gust_knots != null) b.g = Math.max(b.g ?? 0, p.gust_knots);
      if (p.dir != null) { b.u += p.wind_knots * Math.sin(p.dir * RAD); b.v += p.wind_knots * Math.cos(p.dir * RAD); }
      if (p.solar != null) { b.ns += 1; b.s += p.solar; }
    }
  }
  const points = [...bins.values()].sort((a, b) => a.ts - b.ts).map((b) => ({
    ts: b.ts, wind_knots: Math.round((b.w / b.n) * 10) / 10, gust_knots: b.g,
    dir: b.u || b.v ? Math.round((Math.atan2(b.u, b.v) / RAD + 360) % 360) : null,
    solar: b.ns ? Math.round(b.s / b.ns) : null,
  }));
  const final = weeks.every((c) => c.final) && start + size + res + 3600 <= nowSec();
  storeChunk(job, { points, final, failed: weeks.some((c) => c.failed), fetchedAt: Date.now() });
}

async function fetchChunk(job) {
  try {
    const res = await fetch(`/api/history?level=${job.level}&chunk=${job.start}&v=${HISTORY_VERSION}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    if (body.server_time) clockOffset = body.server_time - Math.floor(Date.now() / 1000);
    if (body.station) station = body.station;
    if (body.since) sinceSec = body.since;
    storeChunk(job, { points: body.points || [], final: !!body.final, fetchedAt: Date.now() });
  } catch (err) {
    // Throttled or offline: retry with backoff, then give up for a while
    // (keeping an older copy of the chunk if there is one).
    if (job.attempt < RETRY_MS.length) {
      setTimeout(() => { queue.push(job); pump(); }, RETRY_MS[job.attempt++]);
      return;
    }
    const old = chunks[job.level].get(job.start);
    storeChunk(job, old ? { ...old, fetchedAt: Date.now() }
      : { points: [], final: false, failed: true, fetchedAt: Date.now() });
  }
}

// Load the chunks a window needs plus one screen of margin either side,
// nearest first. Resolves when the visible ones are in.
function loadAround(level, fromSec, toSec, basePriority = 0) {
  const span = toSec - fromSec;
  const center = (fromSec + toSec) / 2;
  const size = LEVELS[level].chunk;
  const visible = [];
  for (const s of chunkStarts(level, fromSec - span, toSec + span)) {
    const p = requestChunk(level, s, basePriority + Math.abs(s + size / 2 - center) / size);
    if (s + size > fromSec && s <= toSec) visible.push(p);
  }
  return Promise.all(visible);
}

let rebuildQueued = false;
function onChunkLoaded(level) {
  if (!clim.started) startClimate(); // once the first response told us where history starts
  if (!fc.started) startForecast();
  if (level === "30min") {
    sky.envelopes.clear();
    clim.days = null;
    scheduleClimate();
    scheduleTable();
  }
  if (!windChart) return;
  if (level === currentLevel) {
    if (!rebuildQueued) {
      rebuildQueued = true;
      requestAnimationFrame(() => { rebuildQueued = false; rebuildData(); });
    }
  } else if (level === "30min" && skyActive()) {
    windChart.draw();
  }
}

// Small "carregando…" next to the hint while visible chunks are on their way.
let busyTimer = null;
function updateBusy() {
  if (!windChart) return;
  const [from, to] = viewRange();
  const size = LEVELS[currentLevel].chunk;
  const busy = [...jobs.values()].some((j) =>
    j.level === currentLevel && j.start + size > from && j.start <= to);
  const el = document.getElementById("chartBusy");
  clearTimeout(busyTimer);
  if (busy) busyTimer = setTimeout(() => { el.hidden = false; }, 200);
  else el.hidden = true;
}
