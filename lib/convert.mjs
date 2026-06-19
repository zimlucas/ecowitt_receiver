// Unit conversions and aggregation helpers.
// These mirror the maths used in local_monitor.py so the data posted from
// Netlify is identical to the original local script.

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fahrenheitToCelsius(f) {
  const v = toNumber(f);
  return v === null ? null : Math.round(((v - 32) * 5) / 9 * 10) / 10;
}

export function mphToKnots(mph) {
  const v = toNumber(mph);
  return v === null ? null : Math.round(v * 0.868976 * 10) / 10;
}

export function mphToMs(mph) {
  const v = toNumber(mph);
  return v === null ? null : Math.round(v * 0.44704 * 100) / 100;
}

export function mphToKmh(mph) {
  const v = toNumber(mph);
  return v === null ? null : Math.round(v * 1.609344 * 10) / 10;
}

export function inhgToHpa(inhg) {
  const v = toNumber(inhg);
  return v === null ? null : Math.round(v * 33.8639 * 10) / 10;
}

export function median(values) {
  const valid = values.map(toNumber).filter((v) => v !== null);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a - b);
  const n = valid.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

export function maxValue(values) {
  const valid = values.map(toNumber).filter((v) => v !== null);
  return valid.length ? Math.max(...valid) : null;
}

// Circular mean for wind directions (degrees).
export function circularMean(angles) {
  const valid = angles.map(toNumber).filter((v) => v !== null);
  if (valid.length === 0) return null;
  let sin = 0;
  let cos = 0;
  for (const a of valid) {
    sin += Math.sin((a * Math.PI) / 180);
    cos += Math.cos((a * Math.PI) / 180);
  }
  let mean = (Math.atan2(sin, cos) * 180) / Math.PI;
  if (mean < 0) mean += 360;
  return Math.round(mean);
}

// 16-point compass label for a bearing in degrees.
export function compass(deg) {
  if (deg === null || deg === undefined) return null;
  const dirs = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Aggregate an array of raw samples (imperial units, as read from Ecowitt) into
// a single set of values, exactly like aggregate_measurements() in local_monitor.py.
// Returns { raw, display }.
export function aggregate(samples) {
  const pick = (key) => samples.map((s) => s[key]);

  const raw = {
    temp_f: median(pick("temp_f")),
    dewpt_f: median(pick("dewpt_f")),
    humidity: median(pick("humidity")),
    wind_speed_mph: median(pick("wind_speed_mph")),
    wind_gust_mph: maxValue(pick("wind_gust_mph")), // MAX for gusts
    wind_direction: circularMean(pick("wind_direction")),
    pressure_inhg: median(pick("pressure_inhg")),
    uv: median(pick("uv")),
    solar: median(pick("solar")),
  };

  return { raw, display: toDisplay(raw) };
}

// Convert one raw (imperial) reading into the friendly units the dashboard shows.
export function toDisplay(raw) {
  return {
    temp_c: fahrenheitToCelsius(raw.temp_f),
    dewpt_c: fahrenheitToCelsius(raw.dewpt_f),
    humidity: toNumber(raw.humidity),
    wind_knots: mphToKnots(raw.wind_speed_mph),
    gust_knots: mphToKnots(raw.wind_gust_mph),
    wind_ms: mphToMs(raw.wind_speed_mph),
    gust_ms: mphToMs(raw.wind_gust_mph),
    wind_kmh: mphToKmh(raw.wind_speed_mph),
    gust_kmh: mphToKmh(raw.wind_gust_mph),
    wind_direction: raw.wind_direction ?? null,
    wind_compass: compass(raw.wind_direction),
    pressure_hpa: inhgToHpa(raw.pressure_inhg),
    uv: toNumber(raw.uv),
    solar: toNumber(raw.solar),
  };
}
