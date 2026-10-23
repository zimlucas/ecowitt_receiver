// Measured wind chart: datasets, axes, sun/night/sky layers, arrows, chart factory, view changes.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Chart data ----
// The window as last set (by a button or by pan/zoom, which both write the
// scale options); scales.x only catches up on the next chart update.
function viewRange() {
  const opts = windChart.options.scales.x;
  const x = windChart.scales.x;
  return [(opts.min ?? x.min) / 1000, (opts.max ?? x.max) / 1000];
}

// One arrow every 5 resolution steps, aligned to time so they don't jump
// around as chunks load.
function isArrowPoint(p, res) {
  return p.dir != null && p.wind_knots != null && Math.round(p.ts / res) % 5 === 0;
}

// Rebuild the datasets from the loaded chunks around the window (two
// screens either side, so panning has data to show immediately).
function rebuildData() {
  if (!windChart) return;
  const level = currentLevel;
  const res = LEVELS[level].res;
  const [from, to] = viewRange();
  const span = to - from;
  const pts = [];
  for (const s of chunkStarts(level, from - 2 * span, to + 2 * span)) {
    const c = chunks[level].get(s);
    if (c) for (const p of c.points) pts.push(p);
  }
  pts.sort((a, b) => a.ts - b.ts);
  // Ecowitt publishes each 5-min history point ~10 min late: continue the
  // line with the live readings taken since then. A live reading less
  // than 4 min after the last history point would overlap it, so the tail
  // starts after that.
  if (level === "5min" && pts.length) {
    const last = pts[pts.length - 1].ts;
    for (const p of liveTail) if (p.ts >= last + LIVE_GAP_SEC && p.ts <= to + 2 * span) pts.push(p);
  }

  // Break the line across holes (not loaded yet, or station offline). At
  // least 2 h, because 5-min chunks older than ~90 days hold 30-min data.
  const gapSec = Math.max(3 * res, 7200);
  const wind = [], gust = [], arrows = [];
  dirByTs = new Map();
  let prev = null;
  for (const p of pts) {
    if (prev !== null && p.ts === prev) continue; // chunk boundaries repeat a point
    if (prev !== null && p.ts - prev > gapSec) wind.push({ x: (prev + res) * 1000, y: null });
    if (p.wind_knots != null) wind.push({ x: p.ts * 1000, y: p.wind_knots });
    if (p.gust_knots != null) gust.push({ x: p.ts * 1000, y: p.gust_knots });
    if (p.dir != null) dirByTs.set(p.ts * 1000, p.dir);
    if (isArrowPoint(p, res)) arrows.push(p);
    prev = p.ts;
  }
  windChart.data.datasets[0].data = wind;
  windChart.data.datasets[1].data = gust;
  windChart.$arrows = arrows;
  rebuildForecast(level, from, to);
  updateLimits();
  updateYAxis(from * 1000, to * 1000);
  windChart.update("none");
  fcChart.update("none");
  document.getElementById("skyLegend").hidden = !skyActive();
  setHint();
  updateBusy();
}

// ---- Y axis ----
// Steps of 5 knots; the top is the visible maximum rounded up to the next 5,
// never below 15 (or 25 in "reference line" mode), so it only moves in
// whole steps while panning. Measured and forecast share the same axis so
// they can be compared at a glance.
// Hidden toggle: clicking the word "zoom" in the hint switches that mode,
// which also draws a line at 15 knots. Remembered in this browser.
const REF_KNOTS = 15;
let refMode = localStorage.getItem("windRefLine") === "1";

function updateYAxis(fromMs, toMs) {
  let top = 0;
  for (const chart of [windChart, fcChart]) {
    for (const ds of chart.data.datasets) {
      for (const p of ds.data) if (p.y != null && p.x >= fromMs && p.x <= toMs && p.y > top) top = p.y;
    }
  }
  for (const chart of [windChart, fcChart]) {
    const y = chart.options.scales.y;
    y.min = 0;
    y.max = Math.max(refMode ? 25 : 15, Math.ceil((top + 0.5) / 5) * 5);
    y.ticks.stepSize = 5;
  }
}

const refLinePlugin = {
  id: "refLine",
  afterDatasetsDraw(chart) {
    if (!refMode) return;
    const { ctx, chartArea: a, scales: { y } } = chart;
    const py = Math.round(y.getPixelForValue(REF_KNOTS)) + 0.5;
    ctx.save();
    ctx.strokeStyle = "rgba(255,174,87,0.75)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
    ctx.restore();
  },
};

function toggleRefMode() {
  refMode = !refMode;
  localStorage.setItem("windRefLine", refMode ? "1" : "0");
  if (windChart) rebuildData();
}

// Pan/zoom bounds: from the first day of history up to now.
function updateLimits() {
  const minMs = (sinceSec ?? nowSec() - 400 * DAY) * 1000;
  for (const chart of [windChart, fcChart]) {
    chart.options.plugins.zoom.limits = { x: { min: minMs, max: nowSec() * 1000, minRange: HOUR_MS } };
  }
}

function setWindow(fromSec, toSec) {
  for (const chart of [windChart, fcChart]) {
    chart.options.scales.x.min = fromSec * 1000;
    chart.options.scales.x.max = toSec * 1000;
  }
}

// Either chart can be dragged or zoomed: copy its window to the other one
// right away, so they move together.
function syncWindow(src) {
  const other = src === windChart ? fcChart : windChart;
  if (!other) return;
  const s = src.options.scales.x, o = other.options.scales.x;
  if (o.min === s.min && o.max === s.max) return;
  o.min = s.min;
  o.max = s.max;
  other.update("none");
}

function setHint() {
  const el = document.getElementById("chartHint");
  const [from, to] = viewRange();
  const failed = chunkStarts(currentLevel, from, to).some((s) => chunks[currentLevel].get(s)?.failed);
  if (failed) { el.textContent = "Parte do histórico não carregou; tentando de novo em instantes."; return; }
  // `since` is a calendar date sent as UTC midnight: read it back in UTC.
  const since = sinceSec ? new Date(sinceSec * 1000) : null;
  el.textContent = `Arraste para ver o histórico${since
    ? ` (desde ${pad2(since.getUTCDate())}/${pad2(since.getUTCMonth() + 1)}/${since.getUTCFullYear()})` : ""}`;
}

// ---- X axis ----
// Ticks sit on round local boundaries. The step adapts to the visible span
// and the chart width, never denser than every 3 hours. Sub-day steps label
// every tick with its time and add the date under the first tick of each day.
let tickUnit = "hour";

function tickStep(minMs, maxMs, widthPx) {
  const maxTicks = Math.max(3, Math.floor(widthPx / 52)); // a "00:00" label needs ~35 px
  const hours = (maxMs - minMs) / HOUR_MS;
  for (const n of [3, 6, 12]) if (hours / n <= maxTicks) return { unit: "hour", n };
  for (const n of [1, 2, 3, 7, 14]) if (hours / 24 / n <= maxTicks) return { unit: "day", n };
  for (const n of [1, 2, 3, 6]) if (hours / (24 * 30.44) / n <= maxTicks) return { unit: "month", n };
  return { unit: "month", n: 12 };
}

// Local calendar day number: aligns multi-day steps so ticks don't jump on pan.
const dayNumber = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);

function niceTicks(minMs, maxMs, widthPx) {
  const { unit, n } = tickStep(minMs, maxMs, widthPx);
  tickUnit = unit;
  const ticks = [];
  const d = new Date(minMs);
  if (unit === "hour") {
    d.setMinutes(0, 0, 0);
    while (d.getTime() < minMs || d.getHours() % n !== 0) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= maxMs; d.setHours(d.getHours() + n)) ticks.push(d.getTime());
  } else if (unit === "day") {
    d.setHours(0, 0, 0, 0);
    while (d.getTime() < minMs || dayNumber(d) % n !== 0) d.setDate(d.getDate() + 1);
    for (; d.getTime() <= maxMs; d.setDate(d.getDate() + n)) ticks.push(d.getTime());
  } else {
    d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() < minMs || (d.getFullYear() * 12 + d.getMonth()) % n !== 0) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= maxMs; d.setMonth(d.getMonth() + n)) ticks.push(d.getTime());
  }
  return ticks.map((value) => ({ value }));
}

function axisLabel(value, index, ticks) {
  const d = new Date(value);
  const prev = index > 0 ? new Date(ticks[index - 1].value) : null;
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  if (tickUnit === "hour") {
    const time = `${pad2(d.getHours())}:00`;
    return !prev || prev.getDate() !== d.getDate() ? [time, date] : time;
  }
  if (tickUnit === "day") return date;
  const month = MONTHS[d.getMonth()];
  return !prev || prev.getFullYear() !== d.getFullYear() ? [month, String(d.getFullYear())] : month;
}

// Midnight gridlines a little stronger, so days stand out in sub-day views.
function gridColor(ctx) {
  const v = ctx.tick && ctx.tick.value;
  const midnight = v != null && tickUnit === "hour" && new Date(v).getHours() === 0;
  return midnight ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
}

function tooltipTitle(ms) {
  const d = new Date(ms);
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  if (currentLevel === "1day") return `${date}/${d.getFullYear()}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---- Sun ----
const RAD = Math.PI / 180;

// Solar elevation in degrees (low-precision USNO formulas, ~0.5 deg).
function sunElevation(ts, lat, lon) {
  const d = ts / 86400 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d;
  const hourAngle = (gmst * 15 + lon) * RAD - ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) +
    Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(hourAngle)) / RAD;
}

// Clear-sky global horizontal irradiance in W/m2 (Haurwitz model).
function clearSkyGhi(elevDeg) {
  const s = Math.sin(elevDeg * RAD);
  return s <= 0 ? 0 : 1098 * s * Math.exp(-0.057 / s);
}

// ---- Night shading ----
// Night is shaded in the plot (and the emoji band above it), fading through
// twilight. It says "night" without claiming anything about the sky, and
// makes the day/night wind cycle easy to see. 24h and week views only.
const NIGHT_ALPHA = 0.55;
const nightPlugin = {
  id: "night",
  beforeDatasetsDraw(chart) {
    if (!skyActive()) return;
    const { ctx, chartArea: a, scales: { x } } = chart;
    const top = Math.round(a.top - SKY_BAND + 4);
    const left = Math.round(a.left), right = Math.round(a.right);
    const step = 2;
    ctx.save();
    for (let px = left; px < right; px += step) {
      const t = x.getValueForPixel(px + step / 2) / 1000;
      const elev = sunElevation(t, station.lat, station.lon);
      // Fully dark below -6 deg (end of civil twilight), clear above +4 deg.
      const alpha = Math.min(1, Math.max(0, (4 - elev) / 10)) * NIGHT_ALPHA;
      if (alpha <= 0.005) continue;
      ctx.fillStyle = `rgba(3,7,18,${alpha.toFixed(3)})`;
      ctx.fillRect(px, top, Math.min(step, right - px), a.bottom - top);
    }
    ctx.restore();
  },
};

// ---- Sky condition, estimated from solar irradiance ----
// Each period compares the measured irradiance with what a clear sky would
// give at that time and place (sun position + Haurwitz clear-sky model). The
// ratio (clear-sky index) picks one of five classes.
//
// The station gets less sun than the model at some hours (on cloudless days
// late afternoon tops out at ~40-60%: an obstacle or sensor tilt), so the
// model is scaled per hour of day by the best ratio the station itself
// reached at that hour over the 3 weeks up to the viewed period (the
// "envelope", from 30-min data).
//
// Periods are hourly when there is room and widen (2 h ... 1 day) as the view
// zooms out. Only the 24h and week levels show it; night and low sun
// (< 10 deg, too unreliable to judge) show nothing.
const SKY_CLASSES = [
  { min: 0.8, emoji: "☀️", label: "Sol aberto" },
  { min: 0.6, emoji: "🌤️", label: "Poucas nuvens" },
  { min: 0.4, emoji: "🌥️", label: "Sol encoberto" },
  { min: 0.2, emoji: "☁️", label: "Fechado" },
  { min: -Infinity, emoji: "☁️", dark: true, label: "Fechado carregado" },
];
const SKY_LEVELS = ["5min", "30min"];
const SKY_MIN_ELEV = 10; // degrees
const SKY_ENVELOPE_DAYS = 21;
const SKY_PERIODS_H = [1, 2, 3, 6, 12, 24];
const SKY_MIN_SLOT_PX = 26;
const SKY_EMOJI_PX = 17;

const sky = { envelopes: new Map(), sprites: null };

function skyActive() {
  return !!station && SKY_LEVELS.includes(currentLevel);
}

// Daylight samples of a chunk (memoised on the chunk): measured vs clear sky.
// `w` is the sample spacing in seconds (a 5-min chunk older than ~90 days
// holds 30-min data).
function chunkSky(chunk) {
  if (chunk.sky) return chunk.sky;
  const out = [];
  const pts = chunk.points;
  const w = pts.length > 1 ? (pts[pts.length - 1].ts - pts[0].ts) / (pts.length - 1) : 300;
  for (const p of pts) {
    if (p.solar == null) continue;
    const elev = sunElevation(p.ts, station.lat, station.lon);
    if (elev < SKY_MIN_ELEV) continue;
    const d = new Date(p.ts * 1000);
    const hour = d.getHours();
    d.setHours(0, 0, 0, 0);
    out.push({ ts: p.ts, solar: p.solar, clear: clearSkyGhi(elev), hour, dayStart: d.getTime(), w });
  }
  return (chunk.sky = out);
}

// Per hour of day, the best hourly clear-sky index in the 3 weeks ending at
// `endSec`. Clamped: above 1 is cloud enhancement, and the floor keeps a
// long cloudy spell from turning every hour into "open sky". Returns null
// until the 30-min chunks it needs have loaded (they're requested here).
function skyEnvelope(endSec) {
  const key = Math.floor(endSec / DAY);
  if (sky.envelopes.has(key)) return sky.envelopes.get(key);
  const fromSec = (key + 1) * DAY - SKY_ENVELOPE_DAYS * DAY;
  const toSec = (key + 1) * DAY;
  const starts = chunkStarts("30min", fromSec, toSec);
  if (starts.some((s) => !chunks["30min"].has(s))) {
    // While the bundle loads, wait for it (its arrival redraws).
    if (bundleReady !== true) return null;
    for (const s of starts) requestChunk("30min", s, 50);
    return null;
  }
  const sums = new Map(); // "dayStart:hour" -> [measured, clear, hour]
  for (const s of starts) {
    for (const smp of chunkSky(chunks["30min"].get(s))) {
      if (smp.ts < fromSec || smp.ts >= toSec) continue;
      const k = `${smp.dayStart}:${smp.hour}`;
      const acc = sums.get(k) || [0, 0, smp.hour];
      acc[0] += smp.solar;
      acc[1] += smp.clear;
      sums.set(k, acc);
    }
  }
  const best = new Array(24).fill(0);
  for (const [measured, clear, hour] of sums.values()) best[hour] = Math.max(best[hour], measured / clear);
  const env = best.map((b) => (b > 0 ? Math.min(1, Math.max(0.35, b)) : 1));
  sky.envelopes.set(key, env);
  return env;
}

// Periods of `hours` length (aligned to local midnight) overlapping the
// window, each with its class. Cheap enough to redo on every frame.
function skyPeriods(level, hours, fromSec, toSec, env) {
  const margin = hours * 3600;
  const groups = new Map();
  for (const s of chunkStarts(level, fromSec - margin, toSec + margin)) {
    const c = chunks[level].get(s);
    if (!c) continue;
    for (const smp of chunkSky(c)) {
      if (smp.ts < fromSec - margin || smp.ts > toSec + margin) continue;
      const start = smp.dayStart + Math.floor(smp.hour / hours) * hours * HOUR_MS;
      let g = groups.get(start);
      if (!g) groups.set(start, (g = { start, measured: 0, ref: 0, cover: 0, first: smp.ts, last: smp.ts }));
      g.measured += smp.solar;
      g.ref += smp.clear * env[smp.hour];
      g.cover += smp.w;
      g.first = Math.min(g.first, smp.ts);
      g.last = Math.max(g.last, smp.ts);
    }
  }
  // Need at least half an hour of daylight data, so dawn/dusk slivers and the
  // hour still in progress don't flicker between classes.
  const out = [];
  for (const g of groups.values()) {
    if (g.cover < 1800 || g.ref <= 0) continue;
    const k = g.measured / g.ref;
    out.push({
      start: g.start, end: g.start + hours * HOUR_MS, x: ((g.first + g.last) / 2) * 1000,
      k, cls: SKY_CLASSES.find((c) => k >= c.min),
    });
  }
  return out;
}

// Emoji are rasterised once per pixel ratio and then just blitted. The heavy
// overcast cloud is the regular cloud darkened (works in every browser,
// unlike canvas filters).
function skySprites() {
  const dpr = window.devicePixelRatio || 1;
  if (sky.sprites && sky.sprites.dpr === dpr) return sky.sprites;
  const make = (cls) => {
    const px = Math.ceil(SKY_EMOJI_PX * dpr * 1.3);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const g = canvas.getContext("2d", { willReadFrequently: !!cls.dark });
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `${SKY_EMOJI_PX * dpr}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    g.fillText(cls.emoji, px / 2, px / 2);
    if (cls.dark) {
      const img = g.getImageData(0, 0, px, px);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { d[i] *= 0.42; d[i + 1] *= 0.45; d[i + 2] *= 0.55; }
      g.putImageData(img, 0, 0);
    }
    return { canvas, size: px / dpr };
  };
  sky.sprites = { dpr, byLabel: new Map(SKY_CLASSES.map((c) => [c.label, make(c)])) };
  return sky.sprites;
}

function skyRange(p) {
  const s = new Date(p.start), e = new Date(p.end);
  return p.end - p.start >= DAY * 1000
    ? `${pad2(s.getDate())}/${pad2(s.getMonth() + 1)}`
    : `${pad2(s.getHours())}h–${pad2(e.getHours())}h`;
}

function skyText(p) {
  return `${p.cls.label} · ${skyRange(p)} · radiação ${Math.round(Math.min(p.k, 1.5) * 100)}% da esperada com céu limpo`;
}

// The measured sky band: periods(hours, fromSec, toSec) -> periods, or
// null while the envelope's data is still loading (the chunk arrival redraws).
const stationSky = {
  periods(hours, fromSec, toSec) {
    const env = skyEnvelope(Math.min(toSec, nowSec()));
    return env && skyPeriods(currentLevel, hours, fromSec, toSec, env);
  },
  text: skyText,
};

// Draws chart.$sky's periods as emoji in the band above the plot.
const skyPlugin = {
  id: "sky",
  afterDraw(chart) {
    const src = chart.$sky;
    chart.$skyVisible = [];
    if (!src || !skyActive()) return;
    const { ctx, chartArea, scales } = chart;
    const xMin = scales.x.min, xMax = scales.x.max;
    const pxPerHour = chartArea.width / ((xMax - xMin) / HOUR_MS);
    const hours = SKY_PERIODS_H.find((h) => h * pxPerHour >= SKY_MIN_SLOT_PX);
    if (!hours) return;
    const periods = src.periods(hours, xMin / 1000, xMax / 1000);
    if (!periods) return;
    const sprites = skySprites();
    const y = chartArea.top - SKY_BAND / 2;
    for (const p of periods) {
      if (p.end < xMin || p.start > xMax) continue;
      const s = sprites.byLabel.get(p.cls.label);
      let x = scales.x.getPixelForValue(p.x);
      if (x < chartArea.left || x > chartArea.right) continue;
      // Nudge edge emoji inside (e.g. today's period, centred near "now").
      x = Math.min(Math.max(x, chartArea.left + s.size / 2), chartArea.right - s.size / 2);
      ctx.drawImage(s.canvas, x - s.size / 2, y - s.size / 2, s.size, s.size);
      chart.$skyVisible.push({ ...p, px: x });
    }
  },
  // Native tooltip when hovering an emoji in the band above the plot.
  afterEvent(chart, args) {
    const e = args.event;
    if (e.type !== "mousemove" && e.type !== "mouseout") return;
    let title = "";
    const top = chart.chartArea.top;
    if (e.type === "mousemove" && e.y < top && e.y > top - SKY_BAND) {
      const hit = (chart.$skyVisible || []).find((p) => Math.abs(p.px - e.x) <= 12);
      if (hit) title = chart.$sky.text(hit);
    }
    if (chart.canvas.title !== title) chart.canvas.title = title;
  },
};

// Minimalist arrows right on the wind line, rotated to flow direction
// (pointing up = wind blowing from south to north).
const windArrowsPlugin = {
  id: "windArrows",
  afterDatasetsDraw(chart) {
    const points = chart.$arrows;
    if (!points || !points.length) return;
    const { ctx, chartArea, scales } = chart;
    const xMin = scales.x.min, xMax = scales.x.max, len = 6;
    ctx.save();
    ctx.strokeStyle = "rgba(232,238,249,0.9)";
    ctx.fillStyle = "rgba(232,238,249,0.9)";
    ctx.lineWidth = 1.3;
    for (const p of points) {
      const xMs = p.ts * 1000;
      if (xMs < xMin || xMs > xMax) continue;
      const x = scales.x.getPixelForValue(xMs);
      if (x < chartArea.left || x > chartArea.right) continue;
      const y = scales.y.getPixelForValue(p.wind_knots);
      const rot = ((Number(p.dir) + 180) % 360) * Math.PI / 180;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.beginPath(); ctx.moveTo(0, len); ctx.lineTo(0, -len); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -len - 1); ctx.lineTo(-3, -len + 4); ctx.lineTo(3, -len + 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  },
};

// ---- Loading overlay ----
let loadingDepth = 0;
let loadingTimer = null;

// Show the "Carregando…" overlay only for loads slower than 150 ms, so cached
// switches don't flash it.
function setLoading(on) {
  const el = document.getElementById("chartLoading");
  loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
  clearTimeout(loadingTimer);
  if (loadingDepth > 0) loadingTimer = setTimeout(() => { el.hidden = false; }, 150);
  else el.hidden = true;
  el.parentElement.toggleAttribute("aria-busy", loadingDepth > 0);
}

const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compassIndex = (deg) => Math.round(Number(deg) / 22.5) % 16;
const compassPt = (deg) => COMPASS[compassIndex(deg)];

function highlightButton(viewKey) {
  document.querySelectorAll("[data-range]").forEach((b) =>
    b.classList.toggle("active", b.dataset.range === viewKey));
}

// Measured and forecast charts share everything but the data; `details(x)`
// adds tooltip lines for the point at x (ms).
function makeWindChart(canvasId, sky, details) {
  const chart = new Chart(document.getElementById(canvasId), {
    type: "scatter",
    plugins: [nightPlugin, refLinePlugin, windArrowsPlugin, skyPlugin],
    data: {
      datasets: [
        { label: "Vento", data: [], showLine: true, borderColor: "#4aa8ff",
          backgroundColor: "#4aa8ff", borderWidth: 2, pointRadius: 0, tension: 0.25, order: 2 },
        { label: "Rajada", data: [], showLine: false, pointRadius: 2.4, pointHoverRadius: 4,
          backgroundColor: "#ffae57", borderColor: "#ffae57", order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      layout: { padding: { top: SKY_BAND } },
      interaction: { mode: "index", intersect: false, axis: "x" },
      scales: {
        x: { type: "linear",
             afterBuildTicks: (axis) => {
               const width = axis.chart.chartArea ? axis.chart.chartArea.width : axis.chart.width;
               axis.ticks = niceTicks(axis.min, axis.max, width);
             },
             ticks: { color: "#8a99b5", maxRotation: 0, autoSkip: false, callback: axisLabel },
             grid: { color: gridColor } },
        y: { min: 0, max: 15, title: { display: true, text: "nós", color: "#8a99b5" },
             ticks: { color: "#8a99b5", stepSize: 5, maxTicksLimit: 30 }, grid: { color: "rgba(255,255,255,0.05)" } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (it) => it.parsed.y != null,
          callbacks: {
            title: (items) => (items.length ? tooltipTitle(items[0].parsed.x) : ""),
            label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(1)} nós`,
            afterBody: (items) => {
              if (!items.length) return [];
              const x = items[0].parsed.x;
              const lines = details(x);
              const period = (items[0].chart.$skyVisible || []).find((p) => x >= p.start && x < p.end);
              if (period) lines.push(`Céu: ${period.cls.label.toLowerCase()}`);
              return lines;
            },
          },
        },
        zoom: {
          pan: { enabled: true, mode: "x", onPan: onViewMove, onPanComplete: onViewSettled },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x",
                  onZoom: onViewMove, onZoomComplete: onViewSettled },
        },
      },
    },
  });
  chart.$sky = sky;
  chart.$arrows = [];
  return chart;
}

function ensureChart() {
  if (windChart) return windChart;
  windChart = makeWindChart("windChart", stationSky, (x) => {
    const dir = dirByTs.get(x);
    return dir != null ? [`Direção: ${Math.round(dir)}° ${compassPt(dir)}`] : [];
  });
  fcChart = makeWindChart("fcChart", forecastSky, forecastDetails);
  return windChart;
}

// ---- View changes ----
// While dragging/zooming either chart: keep the other in step, keep fetching
// ahead and refresh the datasets (throttled). When it settles: switch
// resolution level if the visible span crossed a threshold.
let moveTimer = null;
function onViewMove({ chart }) {
  syncWindow(chart);
  followNow = false;
  if (moveTimer) return;
  moveTimer = setTimeout(() => {
    moveTimer = null;
    const [from, to] = viewRange();
    loadAround(currentLevel, from, to);
    rebuildData();
  }, 120);
}

async function onViewSettled({ chart }) {
  syncWindow(chart);
  const [from, to] = viewRange();
  // Dragged back to the present: resume following new data.
  followNow = nowSec() - to < 2 * LEVELS[currentLevel].res + 60;
  const desired = levelForSpan(to - from);
  if (desired === currentLevel) {
    loadAround(currentLevel, from, to);
    rebuildData();
    return;
  }
  const seq = ++viewSeq;
  setLoading(true);
  try {
    await loadAround(desired, from, to);
    if (seq !== viewSeq) return;
    currentLevel = desired;
    highlightButton(LEVEL_BTN[desired]);
    rebuildData();
  } finally {
    setLoading(false);
  }
}

// Button handler: show `span` ending now, at the matching level. The button
// lights up immediately; if another one is clicked before the data arrives,
// only the latest click is applied.
async function selectView(viewKey) {
  const seq = ++viewSeq;
  const span = VIEW_SPAN[viewKey];
  const level = levelForSpan(span);
  highlightButton(viewKey);
  setLoading(true);
  try {
    const to = nowSec();
    await loadAround(level, to - span, to);
    if (seq !== viewSeq) return;
    ensureChart();
    currentLevel = level;
    followNow = true;
    const end = nowSec(); // the first response may have corrected the clock
    setWindow(end - span, end);
    rebuildData();
    prefetchFor(level);
  } catch (e) {
    if (seq === viewSeq) document.getElementById("chartHint").textContent = "Erro ao carregar histórico.";
  } finally {
    setLoading(false);
  }
}

// Warm what the next likely clicks need, at low priority: the sky envelope
// (3 weeks of 30-min data) and the latest month.
function prefetchFor(level) {
  afterBundle().then(() => {
    const now = nowSec();
    if (SKY_LEVELS.includes(level)) skyEnvelope(now);
    loadAround("30min", now - 7 * DAY, now, 100);
    loadAround("4hour", now - 30 * DAY, now, 200);
  });
}

// Keep the chart live: if the window follows "now", refresh the latest chunk
// when it expires (or redraw when a new live reading came in) and slide the
// window forward.
async function advanceChart(tailChanged = false) {
  if (!windChart || !followNow || loadingDepth > 0) return;
  const level = currentLevel;
  const live = alignChunk(level, nowSec());
  if (chunkFresh(level, live) && !tailChanged) return;
  const seq = viewSeq;
  await requestChunk(level, live, -1);
  if (seq !== viewSeq || level !== currentLevel || !followNow) return;
  const [from, to] = viewRange();
  const end = nowSec();
  setWindow(end - (to - from), end);
  loadAround(level, end - (to - from), end); // e.g. yesterday's chunk turning final
  rebuildData();
}
