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

// Local development (DRY_RUN=1): pretend the upload worked, send nothing.
const dryRun = () => result(true, 0, "dry-run (not sent)");

// The three posts run in parallel and the poller pays for the slowest: a
// service that hangs is cut off rather than billed for up to 15 s.
const POST_TIMEOUT_MS = 8000;

// --------------------------------------------------------------------------
// Windy - Stations API v2
//   GET https://stations.windy.com/api/v2/observation/update?id=<STATION_ID>&...
//   Authorization: Bearer <STATION_PASSWORD>
//
// The station ID and its password are shown on the station's detail page in
// stations.windy.com -> My Stations. The account-wide API key is NOT accepted
// here. Station metadata (name, location, heights) lives in the Windy account.
// Windy accepts at most one observation per 5 min per station and rejects data
// older than ~2 h. The legacy /pws/update/<API_KEY> endpoint shuts down at the
// end of 2026.
// --------------------------------------------------------------------------
export async function postWindy(raw, ts) {
  if (config.dryRun) return dryRun();
  const { stationId, stationPassword } = config.windy;
  if (!stationId || !stationPassword) {
    return result(false, 0, "WINDY_STATION_ID / WINDY_STATION_PASSWORD not set");
  }

  const pressureHpa = inhgToHpa(raw.pressure_inhg);
  const dir = toNumber(raw.wind_direction);

  const params = new URLSearchParams({
    id: stationId,
    ts: String(ts ? Math.floor(ts) : Math.floor(Date.now() / 1000)),
    softwaretype: "EcowittNetlify",
  });
  const add = (key, value) => {
    if (value !== null && value !== undefined) params.set(key, String(value));
  };
  add("temp", fahrenheitToCelsius(raw.temp_f)); // °C
  add("dewpoint", fahrenheitToCelsius(raw.dewpt_f)); // °C
  add("humidity", toNumber(raw.humidity)); // %
  add("wind", mphToMs(raw.wind_speed_mph)); // m/s
  add("gust", mphToMs(raw.wind_gust_mph)); // m/s
  add("winddir", dir === null ? null : Math.round(dir) % 360); // degrees
  add("pressure", pressureHpa === null ? null : Math.round(pressureHpa * 100)); // Pa
  add("uv", toNumber(raw.uv));
  add("solarradiation", toNumber(raw.solar)); // W/m2

  const url = `https://stations.windy.com/api/v2/observation/update?${params.toString()}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${stationPassword}` },
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const text = (await resp.text()).trim();
    return result(resp.ok, resp.status, resp.ok ? "saved" : text || resp.statusText);
  } catch (err) {
    return result(false, 0, err);
  }
}

// --------------------------------------------------------------------------
// Weather Underground (updateweatherstation.php)
// --------------------------------------------------------------------------
export async function postWunderground(raw, ts) {
  if (config.dryRun) return dryRun();
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
    const resp = await fetch(url, { signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
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
  if (config.dryRun) return dryRun();
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
    const resp = await fetch(url, { signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
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
