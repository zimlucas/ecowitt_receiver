// Centralised configuration.
//
// Secrets are read from environment variables ONLY. Set them in the Netlify UI
// (Site configuration -> Environment variables) and, for local runs, in a
// gitignored .env file (see .env.example). Non-sensitive station metadata keeps
// sensible fallbacks so the dashboard renders out of the box.
//
// SECURITY: never hard-code API keys or passwords here — this repository is public.

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export const config = {
  ecowitt: {
    applicationKey: env("ECOWITT_APPLICATION_KEY", ""),
    apiKey: env("ECOWITT_API_KEY", ""),
    mac: env("ECOWITT_MAC", ""),
    imei: env("ECOWITT_IMEI", ""),
  },

  // Physical station description (used by the dashboard; Windy keeps its own
  // copy in the Windy account).
  station: {
    name: env("STATION_NAME", "Meia Praia Soul"),
    lat: Number(env("STATION_LAT", "-26.86737553003316")),
    lon: Number(env("STATION_LON", "-48.63846963640755")),
    elevation: Number(env("STATION_ELEVATION", "21")), // metres
    tempHeight: Number(env("STATION_TEMP_HEIGHT", "12")), // metres
    windHeight: Number(env("STATION_WIND_HEIGHT", "19")), // metres
    // The Ecowitt history API reads start/end dates in the station's local time.
    timezone: env("STATION_TZ", "America/Sao_Paulo"),
    // First day with data in the Ecowitt history (the chart can't pan before it).
    since: env("STATION_SINCE", "2025-12-18"),
  },

  // Windy Stations API v2: station ID + station password (My Stations -> station).
  windy: {
    stationId: env("WINDY_STATION_ID", ""),
    stationPassword: env("WINDY_STATION_PASSWORD", ""),
  },

  wunderground: {
    id: env("WU_ID", "INAVEG5"),
    password: env("WU_PASSWORD", ""),
  },

  windguru: {
    uid: env("WG_UID", "INAVEG5"),
    password: env("WG_PASSWORD", ""),
  },

  // How many 1-minute samples to aggregate before posting (5 -> post every 5 min).
  samplesPerPost: Number(env("SAMPLES_PER_POST", "5")),

  // DRY_RUN=1 skips the real uploads (set automatically by `npm run dev`).
  dryRun: env("DRY_RUN", "") === "1",
};
