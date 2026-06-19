// Posting logic for Windy, Weather Underground and Windguru.
// Each poster takes the aggregated *raw* (imperial) reading and returns a
// uniform result: { ok, code, message, at }.
import { createHash } from "node:crypto";
import { config } from "./config.mjs";
import {
  fahrenheitToCelsius,
  mphToKnots,
  mphToMs,
  inhgToHpa,
  toNumber,
} from "./convert.mjs";

function utcString(tsSeconds) {
  // "YYYY-MM-DD HH:MM:SS" in UTC. Uses the reading's real time when given,
  // otherwise the current time.
  const d = tsSeconds ? new Date(tsSeconds * 1000) : new Date();
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function result(ok, code, message) {
  return { ok, code, message: String(message ?? "").slice(0, 120), at: new Date().toISOString() };
}

// --------------------------------------------------------------------------
// Windy  (https://stations.windy.com/pws/update/<API_KEY>)
//
// We send ONLY observations (no "stations" metadata array). Sending station
// metadata on the upload endpoint is deprecated and returns HTTP 410; sending
// just the observations returns a clean 200. The station's metadata (name,
// location, sensor heights) is configured once in the Windy account itself.
// --------------------------------------------------------------------------
export async function postWindy(raw, ts) {
  const tempC = fahrenheitToCelsius(raw.temp_f);
  const dewC = fahrenheitToCelsius(raw.dewpt_f);
  const windMs = mphToMs(raw.wind_speed_mph);
  const gustMs = mphToMs(raw.wind_gust_mph);
  const pressureHpa = inhgToHpa(raw.pressure_inhg);
  const dir = toNumber(raw.wind_direction);
  const rh = toNumber(raw.humidity);
  const uv = toNumber(raw.uv);

  const obs = { dateutc: utcString(ts) };
  if (tempC !== null) obs.temp = tempC;
  if (windMs !== null) obs.wind = windMs;
  if (dir !== null) obs.winddir = Math.round(dir);
  if (gustMs !== null) obs.gust = gustMs;
  if (rh !== null) obs.rh = rh;
  if (dewC !== null) obs.dewpoint = dewC;
  if (pressureHpa !== null) obs.mbar = pressureHpa;
  if (uv !== null) obs.uv = uv;

  const payload = { observations: [obs] };

  const url = `https://stations.windy.com/pws/update/${config.windy.apiKey}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    return result(resp.ok, resp.status, resp.ok ? "saved" : text);
  } catch (err) {
    return result(false, 0, err);
  }
}

// --------------------------------------------------------------------------
// Weather Underground (updateweatherstation.php)
// --------------------------------------------------------------------------
export async function postWunderground(raw, ts) {
  const params = new URLSearchParams({
    ID: config.wunderground.id,
    PASSWORD: config.wunderground.password,
    dateutc: utcString(ts),
    action: "updateraw",
    softwaretype: "EcowittNetlify",
  });

  const add = (key, value) => {
    const v = toNumber(value);
    if (v !== null) params.set(key, String(v));
  };
  add("tempf", raw.temp_f);
  add("dewptf", raw.dewpt_f);
  add("humidity", raw.humidity);
  add("windspeedmph", raw.wind_speed_mph);
  add("windgustmph", raw.wind_gust_mph);
  add("winddir", raw.wind_direction);
  add("baromin", raw.pressure_inhg);
  add("UV", raw.uv);
  add("solarradiation", raw.solar);

  const url = `https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php?${params.toString()}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = (await resp.text()).trim();
    const ok = resp.ok && /success/i.test(text);
    return result(ok, resp.status, text || (ok ? "success" : "no response"));
  } catch (err) {
    return result(false, 0, err);
  }
}

// --------------------------------------------------------------------------
// Windguru (upload/api.php) - live only, no historical (rejects data > 2h old).
// --------------------------------------------------------------------------
export async function postWindguru(raw, ts) {
  const tempC = fahrenheitToCelsius(raw.temp_f);
  const windKnots = mphToKnots(raw.wind_speed_mph);
  const gustKnots = mphToKnots(raw.wind_gust_mph);
  const pressureHpa = inhgToHpa(raw.pressure_inhg);
  const dir = toNumber(raw.wind_direction);
  const rh = toNumber(raw.humidity);

  const unixtime = ts ? Math.floor(ts) : Math.floor(Date.now() / 1000);
  const salt = String(unixtime);
  const hash = createHash("md5")
    .update(`${salt}${config.windguru.uid}${config.windguru.password}`)
    .digest("hex");

  const params = new URLSearchParams({
    uid: config.windguru.uid,
    salt,
    hash,
    unixtime: String(unixtime),
    interval: "300",
  });

  const add = (key, value) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
  };
  add("wind_avg", windKnots);
  add("wind_max", gustKnots);
  add("wind_direction", dir);
  add("temperature", tempC);
  add("rh", rh);
  add("mslp", pressureHpa);

  const url = `https://www.windguru.cz/upload/api.php?${params.toString()}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = (await resp.text()).trim();
    const ok = resp.ok && /OK/i.test(text);
    return result(ok, resp.status, text || (ok ? "OK" : "no response"));
  } catch (err) {
    return result(false, 0, err);
  }
}

// Post the aggregated reading to all three services in parallel.
// `ts` (Unix seconds) is the real observation time; when omitted, "now" is used.
export async function postAll(raw, ts) {
  const [windy, wunderground, windguru] = await Promise.all([
    postWindy(raw, ts),
    postWunderground(raw, ts),
    postWindguru(raw, ts),
  ]);
  return { windy, wunderground, windguru };
}
