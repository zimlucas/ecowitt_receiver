// Ecowitt Cloud API access.
import { config } from "./config.mjs";
import { toNumber } from "./convert.mjs";

const REALTIME_URL = "https://api.ecowitt.net/api/v3/device/real_time";

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
