// ECMWF forecast from Open-Meteo: loading, binning, the forecast chart datasets and sky band.
//
// Classic script, loaded with defer: all js/*.js files share one global scope
// and run in the order index.html lists them, after the page is parsed.

// ---- Forecast ----
// ECMWF IFS (9 km HRES) from Open-Meteo's historical-forecast API: for each
// hour, the value from the most recent model run that covered it, so past
// hours are short-range forecasts and the latest ones come from the current
// run. Hourly, fetched straight from the browser (no key, CORS open): the
// last days first so the default view is quick, then the whole history (or,
// with the browser cache below, just the last days). Refreshed hourly (ECMWF
// runs four times a day). Aggregated levels average
// like the station history does: mean wind, max gust.
//
// The grid point is the nearest sea one: the station sits on the beach and
// its strong wind comes from the sea, while the default (land) point treats
// it as rough terrain, with a weaker mean wind and stronger gusts.
const FC_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const FC_MODEL = "ecmwf_ifs";
const FC_CELL = "sea";
const FC_VARS = ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
  "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"];
const FC_RECENT_DAYS = 10;
const FC_REFRESH_MS = 3600e3;
const FC_RETRY_MS = 60e3;
// The forecast is also kept in this browser (localStorage, as columns): a
// return visit shows it at once and only asks Open-Meteo for the last days,
// the hours that newer runs can still change (an hour is settled once the
// first run after it is out, ~6-8 h later). The whole history is asked only
// when the cache is missing or doesn't reach back to the station's first day.
const FC_SETTLED_DAYS = 2;
const FC_CACHE_KEY = () => `forecast:v1:${FC_MODEL}:${FC_CELL}:${station.lat.toFixed(4)},${station.lon.toFixed(4)}`;
const FC_FIELDS = ["wind_knots", "gust_knots", "dir", "cloud", "low", "mid", "high"];
// Seconds between direction arrows per level (about as dense as the measured ones).
const FC_ARROW_EVERY = { "5min": 3600, "30min": 3 * 3600, "4hour": 5 * 14400, "1day": 5 * 86400 };
const fc = { started: false, full: false, byTs: new Map(), hours: [], shown: new Map(), timer: null };

const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function fetchForecast(fromSec) {
  const q = new URLSearchParams({
    latitude: station.lat, longitude: station.lon, models: FC_MODEL, cell_selection: FC_CELL,
    hourly: FC_VARS.join(","), wind_speed_unit: "kn", timeformat: "unixtime",
    start_date: isoDate(fromSec), end_date: isoDate(nowSec() + DAY),
  });
  const res = await fetch(`${FC_URL}?${q}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.hourly) throw new Error(body.reason || `HTTP ${res.status}`);
  setGridPoint(body.latitude, body.longitude);
  const h = body.hourly;
  return h.time.map((ts, i) => ({
    ts, wind_knots: h.wind_speed_10m[i], gust_knots: h.wind_gusts_10m[i], dir: h.wind_direction_10m[i],
    cloud: h.cloud_cover[i], low: h.cloud_cover_low[i], mid: h.cloud_cover_mid[i], high: h.cloud_cover_high[i],
  }));
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

function readForecastCache() {
  try {
    const c = JSON.parse(localStorage.getItem(FC_CACHE_KEY()) || "null");
    if (!c?.ts?.length) return false;
    let ts = 0;
    mergeForecast(c.ts.map((dt, i) => {
      ts += dt;
      const p = { ts };
      FC_FIELDS.forEach((f) => { p[f] = c[f][i]; });
      return p;
    }));
    if (c.point) setGridPoint(c.point.lat, c.point.lon);
    fc.full = fc.hours[0].ts <= sinceSec + 3600;
    return true;
  } catch (e) {
    return false;
  }
}

function saveForecastCache() {
  try {
    const c = { saved: Date.now(), point: fc.point, ts: [] };
    FC_FIELDS.forEach((f) => { c[f] = []; });
    let prev = 0;
    for (const p of fc.hours) {
      c.ts.push(p.ts - prev); // deltas: mostly 3600
      prev = p.ts;
      FC_FIELDS.forEach((f) => c[f].push(p[f]));
    }
    localStorage.setItem(FC_CACHE_KEY(), JSON.stringify(c));
  } catch (e) {
    // Quota or private mode: the next visit just downloads it again.
  }
}

function mergeForecast(points) {
  for (const p of points) fc.byTs.set(p.ts, p);
  fc.hours = [...fc.byTs.values()].sort((a, b) => a.ts - b.ts);
  if (windChart) rebuildData();
  scheduleTable();
}

function setFcBusy(text) {
  document.getElementById("fcBusy").hidden = !text;
  if (text) document.getElementById("fcBusyText").textContent = text;
}

async function loadForecast() {
  clearTimeout(fc.timer);
  if (!fc.hours.length) setFcBusy("carregando previsão…");
  try {
    // With the history at hand, only the hours that can still change.
    mergeForecast(await fetchForecast(nowSec() - (fc.full ? FC_SETTLED_DAYS : FC_RECENT_DAYS) * DAY));
    if (!fc.full) {
      setFcBusy("carregando histórico da previsão…");
      mergeForecast(await fetchForecast(sinceSec));
      fc.full = true;
      scheduleTable();
    }
    saveForecastCache();
    setFcBusy(null);
    fc.timer = setTimeout(loadForecast, FC_REFRESH_MS);
  } catch (err) {
    setFcBusy("previsão indisponível, tentando de novo…");
    fc.timer = setTimeout(loadForecast, FC_RETRY_MS);
  }
}

function startForecast() {
  if (fc.started || !sinceSec || !station) return;
  fc.started = true;
  readForecastCache();
  loadForecast();
}

// Hourly points into `res`-second bins (UTC-aligned, like the station's).
function binForecast(res, lo, hi) {
  const bins = new Map();
  for (const p of fc.hours) {
    if (p.ts < lo - res || p.ts > hi || p.wind_knots == null) continue;
    const ts = Math.floor(p.ts / res) * res;
    let b = bins.get(ts);
    if (!b) bins.set(ts, (b = { ts, n: 0, wind: 0, gust: null, u: 0, v: 0, nc: 0, cloud: 0, low: 0, mid: 0, high: 0 }));
    b.n += 1;
    b.wind += p.wind_knots;
    if (p.gust_knots != null) b.gust = Math.max(b.gust ?? 0, p.gust_knots);
    if (p.dir != null) { b.u += p.wind_knots * Math.sin(p.dir * RAD); b.v += p.wind_knots * Math.cos(p.dir * RAD); }
    if (p.cloud != null) {
      b.nc += 1; b.cloud += p.cloud; b.low += p.low ?? 0; b.mid += p.mid ?? 0; b.high += p.high ?? 0;
    }
  }
  return [...bins.values()].sort((a, b) => a.ts - b.ts).map((b) => ({
    ts: b.ts, wind_knots: b.wind / b.n, gust_knots: b.gust,
    dir: b.u || b.v ? (Math.atan2(b.u, b.v) / RAD + 360) % 360 : null,
    cloud: b.nc ? b.cloud / b.nc : null, low: b.nc ? b.low / b.nc : null,
    mid: b.nc ? b.mid / b.nc : null, high: b.nc ? b.high / b.nc : null,
  }));
}

// Forecast datasets for the window (two screens either side, up to now).
function rebuildForecast(level, from, to) {
  const span = to - from;
  const lo = from - 2 * span, hi = Math.min(to + 2 * span, nowSec());
  const res = LEVELS[level].res;
  const pts = res <= 3600 ? fc.hours.filter((p) => p.ts >= lo && p.ts <= hi) : binForecast(res, lo, hi);
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
    lines.push(`Nuvens: ${Math.round(p.cloud)}% (baixas ${Math.round(p.low)}%, médias ${Math.round(p.mid)}%, altas ${Math.round(p.high)}%)`);
  }
  return lines;
}

// Same five sky classes as the measured band, from the model's cloud cover
// (%): thick low overcast counts as "carregado".
function cloudClass(cloud, low) {
  if (cloud < 20) return SKY_CLASSES[0];
  if (cloud < 50) return SKY_CLASSES[1];
  if (cloud < 80) return SKY_CLASSES[2];
  return low >= 80 ? SKY_CLASSES[4] : SKY_CLASSES[3];
}

// Forecast sky band: mean cloud cover over the period's hours with the sun
// at least 10 deg up (the same hours the measured band uses).
const forecastSky = {
  periods(hours, fromSec, toSec) {
    if (!fc.hours.length) return null;
    const margin = hours * 3600;
    const hi = Math.min(toSec + margin, nowSec());
    const groups = new Map();
    for (const p of fc.hours) {
      if (p.ts < fromSec - margin || p.ts > hi || p.cloud == null) continue;
      p.sun ??= sunElevation(p.ts + 1800, station.lat, station.lon);
      if (p.sun < SKY_MIN_ELEV) continue;
      const d = new Date(p.ts * 1000);
      const hour = d.getHours();
      d.setHours(0, 0, 0, 0);
      const start = d.getTime() + Math.floor(hour / hours) * hours * HOUR_MS;
      let g = groups.get(start);
      if (!g) groups.set(start, (g = { start, n: 0, cloud: 0, low: 0, first: p.ts, last: p.ts }));
      g.n += 1;
      g.cloud += p.cloud;
      g.low += p.low ?? 0;
      g.first = Math.min(g.first, p.ts);
      g.last = Math.max(g.last, p.ts);
    }
    return [...groups.values()].map((g) => {
      const cloud = g.cloud / g.n, low = g.low / g.n;
      return { start: g.start, end: g.start + hours * HOUR_MS, x: ((g.first + g.last + 3600) / 2) * 1000,
        cloud, low, cls: cloudClass(cloud, low) };
    });
  },
  text: (p) => `${p.cls.label} · ${skyRange(p)} · nuvens ${Math.round(p.cloud)}% (baixas ${Math.round(p.low)}%)`,
};
