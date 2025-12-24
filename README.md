# Ecowitt Receiver

This project runs a small Flask app (deployable on Railway) that can:

- Receive GW1200/GW1200-style DIY uploads at `POST/GET /ecowitt`
- Pull real-time data from Ecowitt Cloud at `GET /ecowitt/real_time`

## Railway setup (Ecowitt Cloud pull)

Set these environment variables in Railway:

- `ECOWITT_APPLICATION_KEY` (from ecowitt.net)
- `ECOWITT_API_KEY` (from ecowitt.net)
- `ECOWITT_MAC` **or** `ECOWITT_IMEI` (device identifier)

Optional (recommended):

- `PULL_TOKEN` (any random string). If set, `/ecowitt/real_time` requires either:
  - header `X-Pull-Token: <token>` **or**
  - query param `?token=<token>`

Then call:

- `https://<your-railway-domain>/ecowitt/real_time`

Optional query passthrough:

- `call_back`, `temp_unitid`, `pressure_unitid`, `wind_speed_unitid`, `rainfall_unitid`, `solar_irradiance_unitid`, `capacity_unitid`

Example:

- `https://<domain>/ecowitt/real_time?call_back=all`

## Local run (Windows)

```powershell
py -m pip install -r requirements.txt
$env:PORT=5000
py app.py
```

Then visit:

- `http://127.0.0.1:5000/`
- `http://127.0.0.1:5000/ecowitt/real_time` (requires env vars above)
