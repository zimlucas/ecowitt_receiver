// ECMWF forecast from Open-Meteo: loading, binning, the forecast chart datasets and sky band.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Forecast ----
// ECMWF IFS (9 km HRES) from Open-Meteo, in three series the chart and the
// hour-by-hour table each switch between (separately):
//   - latest: the historical-forecast API, for each hour the value from the
//     most recent model run that covered it, so past hours are short-range
//     forecasts and the latest ones come from the current run;
//   - d1 / d3: the previous-runs API, for each hour the value predicted 24 h
//     (or 72 h) before it. That API has no gusts nor low/mid/high clouds for
//     this model, only mean wind, direction and total cloud cover.
// The next 24 h always come from the latest run, whatever the choice.
//
// Hourly, fetched straight from the browser (no key, CORS open): the last
// days first so the default view is quick, then the whole history (or, with
// the browser cache below, just the last days). Refreshed hourly (ECMWF runs
// four times a day). Aggregated levels average like the station history
// does: mean wind, max gust.
//
// The grid point is the nearest sea one: the station sits on the beach and
// its strong wind comes from the sea, while the default (land) point treats
// it as rough terrain, with a weaker mean wind and stronger gusts.
const FC_MODEL = "ecmwf_ifs";
const FC_CELL = "sea";
// Point field -> Open-Meteo hourly variable.
const FC_VAR = {
  wind_knots: "wind_speed_10m", gust_knots: "wind_gusts_10m", dir: "wind_direction_10m",
  cloud: "cloud_cover", low: "cloud_cover_low", mid: "cloud_cover_mid", high: "cloud_cover_high",
};
const FC_FIELDS = Object.keys(FC_VAR);
const FC_RECENT_DAYS = 10;
const FC_REFRESH_MS = 3600e3;
const FC_RETRY_MS = 60e3;
// Each series is also kept in this browser (localStorage, as columns): a
// return visit shows it at once and only asks Open-Meteo for the last days,
// the hours that newer runs can still change (an hour is settled once the
// first run after it is out, ~6-8 h later). The whole history is asked only
// when the cache is missing or doesn't reach back to the station's first day.
const FC_SETTLED_DAYS = 2;
const FC_SERIES = {
  latest: {
    url: "https://historical-forecast-api.open-meteo.com/v1/forecast", suffix: "", fields: FC_FIELDS,
    ahead: 2 * DAY, cache: "", hint: "rodada mais recente para cada hora",
  },
  d1: {
    url: "https://previous-runs-api.open-meteo.com/v1/forecast", suffix: "_previous_day1",
    fields: ["wind_knots", "dir", "cloud"], ahead: 0, cache: ":d1", label: "24 h antes",
    hint: "previsão feita 24 h antes de cada hora (sem rajada) · próximas 24 h: rodada mais recente",
  },
  d3: {
    url: "https://previous-runs-api.open-meteo.com/v1/forecast", suffix: "_previous_day3",
    fields: ["wind_knots", "dir", "cloud"], ahead: 0, cache: ":d3", label: "72 h antes",
    hint: "previsão feita 72 h antes de cada hora (sem rajada) · próximas 24 h: rodada mais recente",
  },
};
for (const [key, s] of Object.entries(FC_SERIES)) {
  Object.assign(s, { key, started: false, full: false, byTs: new Map(), hours: [], timer: null, status: null });
}
const FC_CACHE_KEY = (s) => `forecast:v1:${FC_MODEL}:${FC_CELL}:${station.lat.toFixed(4)},${station.lon.toFixed(4)}${s.cache}`;
// Seconds between direction arrows per level (about as dense as the measured ones).
const FC_ARROW_EVERY = { "5min": 3600, "30min": 3 * 3600, "4hour": 5 * 14400, "1day": 5 * 86400 };
// The chart's choice (`sel`) and the hour-by-hour table's (`tblSel`) are
// separate, each remembered in this browser.
const savedSeries = (k) => (FC_SERIES[localStorage.getItem(k)] ? localStorage.getItem(k) : "latest");
const fc = {
  started: false, sel: savedSeries("fcSeries"), tblSel: savedSeries("tblFcSeries"),
  hours: [], composedHour: null, shown: new Map(),
};

const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function fetchForecast(s, fromSec) {
  const q = new URLSearchParams({
    latitude: station.lat, longitude: station.lon, models: FC_MODEL, cell_selection: FC_CELL,
    hourly: s.fields.map((f) => FC_VAR[f] + s.suffix).join(","), wind_speed_unit: "kn", timeformat: "unixtime",
    start_date: isoDate(fromSec), end_date: isoDate(nowSec() + s.ahead),
  });
  const res = await fetch(`${s.url}?${q}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.hourly) throw new Error(body.reason || `HTTP ${res.status}`);
  setGridPoint(body.latitude, body.longitude);
  const h = body.hourly;
  return h.time.map((ts, i) => {
    const p = { ts };
    for (const f of FC_FIELDS) p[f] = s.fields.includes(f) ? h[FC_VAR[f] + s.suffix]?.[i] ?? null : null;
    return p;
  });
}

// The grid point the forecast comes from: distance in the caption, Windy link.
function setGridPoint(lat, lon) {
  fc.point = { lat, lon };
  const km = distanceKm(station.lat, station.lon, lat, lon);
  document.getElementById("fcWhere").textContent = `, ${Math.round(km)} km pra dentro do mar`;
  const a = lat.toFixed(3), b = lon.toFixed(3);
  document.getElementById("fcWindy").href = `https://www.windy.com/${a}/${b}?${a},${b},11`;
  document.getElementById("fcWindyWrap").hidden = false;
}

function readForecastCache(s) {
  try {
    const c = JSON.parse(localStorage.getItem(FC_CACHE_KEY(s)) || "null");
    if (!c?.ts?.length) return false;
    let ts = 0;
    mergeForecast(s, c.ts.map((dt, i) => {
      ts += dt;
      const p = { ts };
      FC_FIELDS.forEach((f) => { p[f] = c[f] ? c[f][i] : null; });
      return p;
    }));
    if (c.point) setGridPoint(c.point.lat, c.point.lon);
    s.full = s.hours[0].ts <= sinceSec + 3600;
    return true;
  } catch (e) {
    return false;
  }
}

function saveForecastCache(s) {
  try {
    const c = { saved: Date.now(), point: fc.point, ts: [] };
    s.fields.forEach((f) => { c[f] = []; });
    let prev = 0;
    for (const p of s.hours) {
      c.ts.push(p.ts - prev); // deltas: mostly 3600
      prev = p.ts;
      s.fields.forEach((f) => c[f].push(p[f]));
    }
    localStorage.setItem(FC_CACHE_KEY(s), JSON.stringify(c));
  } catch (e) {
    // Quota or private mode: the next visit just downloads it again.
  }
}

// What the page shows: the chosen series up to now, the latest run after.
// Recomposed when a series changes and when the hour turns.
function composeForecast() {
  const now = nowSec(), sel = FC_SERIES[fc.sel], latest = FC_SERIES.latest;
  fc.hours = sel === latest ? latest.hours
    : sel.hours.filter((p) => p.ts <= now).concat(latest.hours.filter((p) => p.ts > now));
  fc.composedHour = Math.floor(now / 3600);
}

function forecastHours() {
  if (fc.composedHour !== Math.floor(nowSec() / 3600)) composeForecast();
  return fc.hours;
}

function mergeForecast(s, points) {
  for (const p of points) s.byTs.set(p.ts, p);
  s.hours = [...s.byTs.values()].sort((a, b) => a.ts - b.ts);
  if (s === FC_SERIES[fc.tblSel]) scheduleTable();
  if (s !== FC_SERIES.latest && s !== FC_SERIES[fc.sel]) return;
  composeForecast();
  if (windChart) rebuildData();
}

// The small "carregando…" by the title: about the chosen series, or the
// latest run (the next 24 h) when that one is still on its way.
function updateFcBusy() {
  const TEXT = { recent: "carregando previsão…", history: "carregando histórico da previsão…",
    error: "previsão indisponível, tentando de novo…" };
  const status = FC_SERIES[fc.sel].status || FC_SERIES.latest.status;
  document.getElementById("fcBusy").hidden = !status;
  if (status) document.getElementById("fcBusyText").textContent = TEXT[status];
}

function setStatus(s, status) {
  s.status = status;
  updateFcBusy();
}

async function loadForecast(s) {
  clearTimeout(s.timer);
  if (!s.hours.length) setStatus(s, "recent");
  try {
    // With the history at hand, only the hours that can still change.
    mergeForecast(s, await fetchForecast(s, nowSec() - (s.full ? FC_SETTLED_DAYS : FC_RECENT_DAYS) * DAY));
    if (!s.full) {
      setStatus(s, "history");
      mergeForecast(s, await fetchForecast(s, sinceSec));
      s.full = true;
      scheduleTable();
    }
    saveForecastCache(s);
    setStatus(s, null);
    s.timer = setTimeout(() => loadForecast(s), FC_REFRESH_MS);
  } catch (err) {
    setStatus(s, "error");
    s.timer = setTimeout(() => loadForecast(s), FC_RETRY_MS);
  }
}

function startSeries(s) {
  if (s.started) return;
  s.started = true;
  readForecastCache(s);
  loadForecast(s);
}

function startForecast() {
  if (fc.started || !sinceSec || !station) return;
  fc.started = true;
  startSeries(FC_SERIES.latest);
  startSeries(FC_SERIES[fc.sel]);
  startSeries(FC_SERIES[fc.tblSel]);
}

// Switch the chart's series. A previous-runs series is only downloaded the
// first time it is picked (here or in the table).
function selectForecast(key) {
  fc.sel = key;
  localStorage.setItem("fcSeries", key);
  showForecastChoice();
  if (fc.started) startSeries(FC_SERIES[key]);
  composeForecast();
  updateFcBusy();
  if (windChart) rebuildData();
}

// Switch the table's series: its forecast columns, filters and histograms
// then compare the measurement with the forecast given that far ahead.
function selectTableForecast(key) {
  fc.tblSel = key;
  localStorage.setItem("tblFcSeries", key);
  showForecastChoice();
  if (fc.started) startSeries(FC_SERIES[key]);
  tbl.limit = TBL_PAGE;
  scheduleTable();
}

function showForecastChoice() {
  const mark = (attr, sel) => document.querySelectorAll(`[${attr}]`).forEach((b) => {
    const on = b.getAttribute(attr) === sel;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
  mark("data-fc", fc.sel);
  mark("data-tblfc", fc.tblSel);
  document.getElementById("fcRunHint").textContent = FC_SERIES[fc.sel].hint;
}

// Hourly points into `res`-second bins (UTC-aligned, like the station's).
function binForecast(hours, res, lo, hi) {
  const bins = new Map();
  for (const p of hours) {
    if (p.ts < lo - res || p.ts > hi || p.wind_knots == null) continue;
    const ts = Math.floor(p.ts / res) * res;
    let b = bins.get(ts);
    if (!b) bins.set(ts, (b = { ts, n: 0, wind: 0, gust: null, u: 0, v: 0, nc: 0, cloud: 0, nl: 0, low: 0, mid: 0, high: 0 }));
    b.n += 1;
    b.wind += p.wind_knots;
    if (p.gust_knots != null) b.gust = Math.max(b.gust ?? 0, p.gust_knots);
    if (p.dir != null) { b.u += p.wind_knots * Math.sin(p.dir * RAD); b.v += p.wind_knots * Math.cos(p.dir * RAD); }
    if (p.cloud != null) { b.nc += 1; b.cloud += p.cloud; }
    if (p.low != null) { b.nl += 1; b.low += p.low; b.mid += p.mid ?? 0; b.high += p.high ?? 0; }
  }
  return [...bins.values()].sort((a, b) => a.ts - b.ts).map((b) => ({
    ts: b.ts, wind_knots: b.wind / b.n, gust_knots: b.gust,
    dir: b.u || b.v ? (Math.atan2(b.u, b.v) / RAD + 360) % 360 : null,
    cloud: b.nc ? b.cloud / b.nc : null, low: b.nl ? b.low / b.nl : null,
    mid: b.nl ? b.mid / b.nl : null, high: b.nl ? b.high / b.nl : null,
  }));
}

// Forecast datasets for the window (two screens either side, up to the end
// of the forecast shown ahead).
function rebuildForecast(level, from, to) {
  const span = to - from;
  const lo = from - 2 * span, hi = Math.min(to + 2 * span, nowSec() + AHEAD_SEC);
  const res = LEVELS[level].res;
  const hours = forecastHours();
  const pts = res <= 3600 ? hours.filter((p) => p.ts >= lo && p.ts <= hi) : binForecast(hours, res, lo, hi);
  const every = FC_ARROW_EVERY[level];
  const wind = [], gust = [], arrows = [];
  fc.shown = new Map();
  for (const p of pts) {
    wind.push({ x: p.ts * 1000, y: p.wind_knots });
    if (p.gust_knots != null) gust.push({ x: p.ts * 1000, y: p.gust_knots });
    if (p.dir != null && p.wind_knots != null && p.ts % every === 0) arrows.push(p);
    fc.shown.set(p.ts * 1000, p);
  }
  fcChart.data.datasets[0].data = wind;
  fcChart.data.datasets[1].data = gust;
  fcChart.$arrows = arrows;
  fcChart.options.scales.x.min = windChart.options.scales.x.min;
  fcChart.options.scales.x.max = windChart.options.scales.x.max;
}

function forecastDetails(x) {
  const p = fc.shown.get(x);
  if (!p) return [];
  const lines = [];
  if (p.dir != null) lines.push(`Direção: ${Math.round(p.dir)}° ${compassPt(p.dir)}`);
  if (p.cloud != null) {
    lines.push(`Nuvens: ${Math.round(p.cloud)}%` + (p.low != null
      ? ` (baixas ${Math.round(p.low)}%, médias ${Math.round(p.mid)}%, altas ${Math.round(p.high)}%)` : ""));
  }
  return lines;
}

// Same five sky classes as the measured band, from the model's cloud cover
// (%): thick low overcast counts as "carregado" (when the layers are known).
function cloudClass(cloud, low) {
  if (cloud < 20) return SKY_CLASSES[0];
  if (cloud < 50) return SKY_CLASSES[1];
  if (cloud < 80) return SKY_CLASSES[2];
  return low != null && low >= 80 ? SKY_CLASSES[4] : SKY_CLASSES[3];
}

// Forecast sky band: mean cloud cover over the period's hours with the sun
// at least 10 deg up (the same hours the measured band uses).
const forecastSky = {
  periods(hours, fromSec, toSec) {
    const all = forecastHours();
    if (!all.length) return null;
    const margin = hours * 3600;
    const hi = Math.min(toSec + margin, nowSec() + AHEAD_SEC);
    const groups = new Map();
    for (const p of all) {
      if (p.ts < fromSec - margin || p.ts > hi || p.cloud == null) continue;
      p.sun ??= sunElevation(p.ts + 1800, station.lat, station.lon);
      if (p.sun < SKY_MIN_ELEV) continue;
      const d = new Date(p.ts * 1000);
      const hour = d.getHours();
      d.setHours(0, 0, 0, 0);
      const start = d.getTime() + Math.floor(hour / hours) * hours * HOUR_MS;
      let g = groups.get(start);
      if (!g) groups.set(start, (g = { start, n: 0, cloud: 0, nl: 0, low: 0, first: p.ts, last: p.ts }));
      g.n += 1;
      g.cloud += p.cloud;
      if (p.low != null) { g.nl += 1; g.low += p.low; }
      g.first = Math.min(g.first, p.ts);
      g.last = Math.max(g.last, p.ts);
    }
    return [...groups.values()].map((g) => {
      const cloud = g.cloud / g.n, low = g.nl ? g.low / g.nl : null;
      return { start: g.start, end: g.start + hours * HOUR_MS, x: ((g.first + g.last + 3600) / 2) * 1000,
        cloud, low, cls: cloudClass(cloud, low) };
    });
  },
  text: (p) => `${p.cls.label} · ${skyRange(p)} · nuvens ${Math.round(p.cloud)}%` +
    (p.low != null ? ` (baixas ${Math.round(p.low)}%)` : ""),
};

document.querySelectorAll("[data-fc]").forEach((b) => b.addEventListener("click", () => selectForecast(b.dataset.fc)));
document.querySelectorAll("[data-tblfc]").forEach((b) => b.addEventListener("click", () => selectTableForecast(b.dataset.tblfc)));
showForecastChoice();
