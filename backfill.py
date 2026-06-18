#!/usr/bin/env python3
"""
Historical backfill for the Ecowitt station.

Pulls history from the Ecowitt Cloud API and re-posts it to the online services
that accept past observations:

  - Weather Underground : one HTTP request per observation, with dateutc set to
                          the real (UTC) time of the reading.  Supports months
                          of history.
  - Windy               : batched observations (many per request), each with its
                          own dateutc.  May reject very old data depending on the
                          account; failures per batch are reported.

  - Windguru is intentionally NOT supported: its API rejects any upload older
    than 2 hours.

This script is meant to be run locally (it can take a long time and must be
throttled to respect the services' rate limits). It is independent from the
Netlify functions.

Examples
--------
    # Backfill everything since the station went live, to Weather Underground:
    python backfill.py --start 2025-09-01 --end 2026-06-18 --targets wu

    # Backfill the last 30 days to both Windy and WU:
    python backfill.py --start 2026-05-19 --end 2026-06-18 --targets wu,windy

Credentials are read from environment variables. For local runs, put them in a
gitignored .env file (see .env.example); it is loaded automatically on startup.
"""
import argparse
import hashlib
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
# Secrets come from environment variables. For local runs, put them in a
# gitignored .env file (see .env.example); it is loaded automatically below.
def _load_dotenv(path=".env"):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

ECOWITT_APPLICATION_KEY = os.environ.get("ECOWITT_APPLICATION_KEY", "")
ECOWITT_API_KEY = os.environ.get("ECOWITT_API_KEY", "")
ECOWITT_MAC = os.environ.get("ECOWITT_MAC", "")

WINDY_API_KEY = os.environ.get("WINDY_API_KEY", "")
WINDY_STATION_ID = int(os.environ.get("WINDY_STATION_ID", "0"))
STATION_NAME = os.environ.get("STATION_NAME", "My Home Station")
STATION_LAT = float(os.environ.get("STATION_LAT", "-26.86737553003316"))
STATION_LON = float(os.environ.get("STATION_LON", "-48.63846963640755"))
STATION_ELEVATION = float(os.environ.get("STATION_ELEVATION", "21"))
STATION_TEMP_HEIGHT = float(os.environ.get("STATION_TEMP_HEIGHT", "12"))
STATION_WIND_HEIGHT = float(os.environ.get("STATION_WIND_HEIGHT", "19"))

WU_ID = os.environ.get("WU_ID", "INAVEG5")
WU_PASSWORD = os.environ.get("WU_PASSWORD", "")


# --------------------------------------------------------------------------
# Unit conversions (identical to lib/convert.mjs and local_monitor.py)
# --------------------------------------------------------------------------
def f_to_c(value):
    try:
        return round((float(value) - 32) * 5 / 9, 1)
    except (ValueError, TypeError):
        return None


def mph_to_ms(value):
    try:
        return round(float(value) * 0.44704, 2)
    except (ValueError, TypeError):
        return None


def inhg_to_hpa(value):
    try:
        return round(float(value) * 33.8639, 1)
    except (ValueError, TypeError):
        return None


def to_float(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------
# Ecowitt history
# --------------------------------------------------------------------------
def fetch_history_day(day_start, day_end):
    """Fetch one [day_start, day_end] window of 5-minute history."""
    params = {
        "application_key": ECOWITT_APPLICATION_KEY,
        "api_key": ECOWITT_API_KEY,
        "mac": ECOWITT_MAC,
        "start_date": day_start.strftime("%Y-%m-%d %H:%M:%S"),
        "end_date": day_end.strftime("%Y-%m-%d %H:%M:%S"),
        "call_back": "indoor,wind,pressure,solar_and_uvi",
        "cycle_type": "5min",
        "temp_unitid": 2,      # Fahrenheit
        "pressure_unitid": 4,  # inHg
        "wind_speed_unitid": 9,  # mph
        "solar_irradiance_unitid": 16,  # W/m2
    }
    url = "https://api.ecowitt.net/api/v3/device/history"
    resp = requests.get(url, params=params, timeout=40)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"Ecowitt history error: {payload.get('msg')}")
    return payload.get("data", {})


def _series(block, group, field):
    """Return the {timestamp: value} dict for data[group][field]['list']."""
    return ((block.get(group, {}) or {}).get(field, {}) or {}).get("list", {}) or {}


def points_from_history(data):
    """Flatten the Ecowitt history block into a list of per-timestamp readings."""
    indoor_temp = _series(data, "indoor", "temperature")
    indoor_dew = _series(data, "indoor", "dew_point")
    indoor_hum = _series(data, "indoor", "humidity")
    wind_spd = _series(data, "wind", "wind_speed")
    wind_gust = _series(data, "wind", "wind_gust")
    wind_dir = _series(data, "wind", "wind_direction")
    press_rel = _series(data, "pressure", "relative")
    solar = _series(data, "solar_and_uvi", "solar")
    uvi = _series(data, "solar_and_uvi", "uvi")

    timestamps = sorted(set(indoor_temp) | set(wind_spd) | set(press_rel), key=lambda t: int(t))
    points = []
    for ts in timestamps:
        points.append({
            "ts": int(ts),
            "temp_f": to_float(indoor_temp.get(ts)),
            "dewpt_f": to_float(indoor_dew.get(ts)),
            "humidity": to_float(indoor_hum.get(ts)),
            "wind_speed_mph": to_float(wind_spd.get(ts)),
            "wind_gust_mph": to_float(wind_gust.get(ts)),
            "wind_direction": to_float(wind_dir.get(ts)),
            "pressure_inhg": to_float(press_rel.get(ts)),
            "solar": to_float(solar.get(ts)),
            "uv": to_float(uvi.get(ts)),
        })
    return points


# --------------------------------------------------------------------------
# Posting (historical)
# --------------------------------------------------------------------------
def post_wu_point(session, p):
    """Post a single historical point to Weather Underground. Returns True/False."""
    dateutc = datetime.fromtimestamp(p["ts"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    params = {
        "ID": WU_ID,
        "PASSWORD": WU_PASSWORD,
        "dateutc": dateutc,
        "action": "updateraw",
        "softwaretype": "EcowittBackfill",
    }
    mapping = {
        "tempf": p["temp_f"],
        "dewptf": p["dewpt_f"],
        "humidity": p["humidity"],
        "windspeedmph": p["wind_speed_mph"],
        "windgustmph": p["wind_gust_mph"],
        "winddir": p["wind_direction"],
        "baromin": p["pressure_inhg"],
        "solarradiation": p["solar"],
        "UV": p["uv"],
    }
    for key, value in mapping.items():
        if value is not None:
            params[key] = value

    url = "https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php"
    try:
        resp = session.get(url, params=params, timeout=15)
        return "success" in resp.text.lower()
    except requests.RequestException:
        return False


def windy_obs(p):
    """Build one Windy observation dict for a historical point."""
    dateutc = datetime.fromtimestamp(p["ts"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    obs = {"dateutc": dateutc}
    temp_c = f_to_c(p["temp_f"])
    dew_c = f_to_c(p["dewpt_f"])
    wind_ms = mph_to_ms(p["wind_speed_mph"])
    gust_ms = mph_to_ms(p["wind_gust_mph"])
    press_hpa = inhg_to_hpa(p["pressure_inhg"])
    if temp_c is not None:
        obs["temp"] = temp_c
    if dew_c is not None:
        obs["dewpoint"] = dew_c
    if wind_ms is not None:
        obs["wind"] = wind_ms
    if gust_ms is not None:
        obs["gust"] = gust_ms
    if p["wind_direction"] is not None:
        obs["winddir"] = int(p["wind_direction"])
    if p["humidity"] is not None:
        obs["rh"] = p["humidity"]
    if press_hpa is not None:
        obs["mbar"] = press_hpa
    if p["uv"] is not None:
        obs["uv"] = p["uv"]
    return obs


def post_windy_batch(session, points):
    """Post a batch of historical points to Windy. Returns True/False.

    Only observations are sent (no "stations" metadata array); sending station
    metadata on the upload endpoint is deprecated and rejected with HTTP 410.
    """
    payload = {"observations": [windy_obs(p) for p in points]}
    url = f"https://stations.windy.com/pws/update/{WINDY_API_KEY}"
    try:
        resp = session.post(url, json=payload, timeout=30)
        return resp.status_code == 200
    except requests.RequestException:
        return False


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def daterange_days(start, end):
    """Yield (day_start, day_end) windows clipped to [start, end]."""
    cursor = start
    while cursor < end:
        nxt = min(cursor + timedelta(days=1), end)
        yield cursor, nxt
        cursor = nxt


def parse_date(text):
    return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main():
    parser = argparse.ArgumentParser(description="Backfill historical Ecowitt data to Windy and Weather Underground.")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD (UTC, inclusive)")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD (UTC, exclusive)")
    parser.add_argument("--targets", default="wu", help="Comma list: wu,windy (default: wu)")
    parser.add_argument("--delay", type=float, default=0.15, help="Seconds between WU requests (default 0.15)")
    parser.add_argument("--windy-batch", type=int, default=200, help="Observations per Windy request (default 200)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and count only; do not post")
    args = parser.parse_args()

    targets = {t.strip().lower() for t in args.targets.split(",") if t.strip()}
    start = parse_date(args.start)
    end = parse_date(args.end)
    if end <= start:
        print("ERROR: --end must be after --start")
        sys.exit(1)

    print(f"Backfill {start.date()} -> {end.date()} | targets={','.join(sorted(targets)) or 'none'} | dry_run={args.dry_run}")
    session = requests.Session()

    totals = {"points": 0, "wu_ok": 0, "wu_fail": 0, "windy_ok": 0, "windy_fail": 0}

    for day_start, day_end in daterange_days(start, end):
        try:
            data = fetch_history_day(day_start, day_end)
        except Exception as exc:  # noqa: BLE001 - report and continue with next day
            print(f"  {day_start.date()}: history fetch failed: {exc}")
            time.sleep(1)
            continue

        points = points_from_history(data)
        totals["points"] += len(points)
        print(f"  {day_start.date()}: {len(points)} points")

        if args.dry_run or not points:
            continue

        # Windy: batched
        if "windy" in targets:
            for i in range(0, len(points), args.windy_batch):
                batch = points[i:i + args.windy_batch]
                ok = post_windy_batch(session, batch)
                totals["windy_ok" if ok else "windy_fail"] += len(batch)
                time.sleep(0.5)

        # Weather Underground: one request per point, throttled
        if "wu" in targets:
            for idx, p in enumerate(points, 1):
                ok = post_wu_point(session, p)
                totals["wu_ok" if ok else "wu_fail"] += 1
                if idx % 50 == 0:
                    print(f"    WU {idx}/{len(points)} (ok={totals['wu_ok']}, fail={totals['wu_fail']})")
                time.sleep(args.delay)

    print("\nDone.")
    print(f"  Total points : {totals['points']}")
    if "wu" in targets:
        print(f"  WU    : ok={totals['wu_ok']} fail={totals['wu_fail']}")
    if "windy" in targets:
        print(f"  Windy : ok={totals['windy_ok']} fail={totals['windy_fail']}")


if __name__ == "__main__":
    main()
