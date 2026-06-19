// Ecowitt Cloud API access.
import { config } from "./config.mjs";
import { toNumber, mphToKnots } from "./convert.mjs";

const REALTIME_URL = "https://api.ecowitt.net/api/v3/device/real_time";
const HISTORY_URL = "https://api.ecowitt.net/api/v3/device/history";

// Fetch the live real-time payload. Returns the parsed JSON or null on failure.
export async function fetchRealtime() {
  const { applicationKey, apiKey, mac, imei } = config.ecowitt;
  const params = new URLSearchParams({
    application_key: applicationKey,
    api_key: apiKey,
    call_back: "all",
  });
  if (mac) params.set("mac", mac);
  if (imei) params.set("imei", imei);

  try {
    const resp = await fetch(`${REALTIME_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      console.error("Ecowitt HTTP error:", resp.status);
      return null;
    }
    const json = await resp.json();
    if (json.code !== 0) {
      console.error("Ecowitt API error:", json.msg);
      return null;
    }
    return json;
  } catch (err) {
    console.error("Ecowitt request failed:", String(err));
    return null;
  }
}

// Turn a real-time payload into one normalised sample of imperial values.
// NOTE: per the user's setup, the `indoor` block holds the outdoor sensor.
export function sampleFromRealtime(json) {
  const data = json?.data || {};
  const indoor = data.indoor || {};
  const wind = data.wind || {};
  const pressure = data.pressure || {};
  const solarUvi = data.solar_and_uvi || {};

  const val = (obj, key) => toNumber(obj?.[key]?.value);

  return {
    ts: toNumber(json?.time) ?? Math.floor(Date.now() / 1000),
    temp_f: val(indoor, "temperature"),
    dewpt_f: val(indoor, "dew_point"),
    humidity: val(indoor, "humidity"),
    wind_speed_mph: val(wind, "wind_speed"),
    wind_gust_mph: val(wind, "wind_gust"),
    wind_direction: val(wind, "wind_direction"),
    pressure_inhg: val(pressure, "relative"),
    uv: val(solarUvi, "uvi"),
    solar: val(solarUvi, "solar"),
  };
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------
function ecowittDate(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// Fetch a window of history. `cycleType` is one of "5min", "30min", "4hour".
// `callBack` selects which sensor blocks to return. Returns the data block.
export async function fetchHistory(startSec, endSec, cycleType = "5min", callBack = "wind") {
  const { applicationKey, apiKey, mac, imei } = config.ecowitt;
  const params = new URLSearchParams({
    application_key: applicationKey,
    api_key: apiKey,
    start_date: ecowittDate(startSec),
    end_date: ecowittDate(endSec),
    call_back: callBack,
    cycle_type: cycleType,
    temp_unitid: "2", // Fahrenheit
    pressure_unitid: "4", // inHg
    wind_speed_unitid: "9", // mph
    solar_irradiance_unitid: "16", // W/m2
  });
  if (mac) params.set("mac", mac);
  if (imei) params.set("imei", imei);

  const resp = await fetch(`${HISTORY_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`Ecowitt history HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.code !== 0) throw new Error(`Ecowitt history: ${json.msg}`);
  return json.data || {};
}

function listOf(data, group, field) {
  return (((data?.[group] || {})[field] || {}).list) || {};
}

// Flatten a history block into a wind series for the chart (knots).
export function windSeriesFromHistory(data) {
  const spd = listOf(data, "wind", "wind_speed");
  const gust = listOf(data, "wind", "wind_gust");
  const dir = listOf(data, "wind", "wind_direction");
  const stamps = new Set([...Object.keys(spd), ...Object.keys(gust)]);
  const out = [];
  for (const t of stamps) {
    out.push({
      ts: Number(t),
      wind_knots: mphToKnots(spd[t]),
      gust_knots: mphToKnots(gust[t]),
      dir: toNumber(dir[t]),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Flatten a history block into full raw (imperial) samples for backfilling.
export function samplesFromHistory(data) {
  const temp = listOf(data, "indoor", "temperature");
  const dew = listOf(data, "indoor", "dew_point");
  const hum = listOf(data, "indoor", "humidity");
  const spd = listOf(data, "wind", "wind_speed");
  const gust = listOf(data, "wind", "wind_gust");
  const dir = listOf(data, "wind", "wind_direction");
  const press = listOf(data, "pressure", "relative");
  const solar = listOf(data, "solar_and_uvi", "solar");
  const uvi = listOf(data, "solar_and_uvi", "uvi");
  const stamps = [...new Set([...Object.keys(temp), ...Object.keys(spd), ...Object.keys(press)])];
  stamps.sort((a, b) => Number(a) - Number(b));
  return stamps.map((t) => ({
    ts: Number(t),
    temp_f: toNumber(temp[t]),
    dewpt_f: toNumber(dew[t]),
    humidity: toNumber(hum[t]),
    wind_speed_mph: toNumber(spd[t]),
    wind_gust_mph: toNumber(gust[t]),
    wind_direction: toNumber(dir[t]),
    pressure_inhg: toNumber(press[t]),
    solar: toNumber(solar[t]),
    uv: toNumber(uvi[t]),
  }));
}
