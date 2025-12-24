import os

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/ecowitt", methods=["GET", "POST"])
def receive_ecowitt():
    data = request.values.to_dict()
    print("Received data:", data)
    return "OK", 200


def _require_pull_token_if_configured():
    configured_token = os.environ.get("PULL_TOKEN")
    if not configured_token:
        return

    provided = request.headers.get("X-Pull-Token") or request.args.get("token")
    if provided != configured_token:
        # Avoid leaking any token details.
        return jsonify({"error": "unauthorized"}), 401


@app.route("/ecowitt/real_time", methods=["GET"])
def ecowitt_real_time():
    token_check = _require_pull_token_if_configured()
    if token_check is not None:
        return token_check

    application_key = os.environ.get("ECOWITT_APPLICATION_KEY")
    api_key = os.environ.get("ECOWITT_API_KEY")
    mac = os.environ.get("ECOWITT_MAC")
    imei = os.environ.get("ECOWITT_IMEI")

    if not application_key or not api_key:
        return (
            jsonify(
                {
                    "error": "missing_server_configuration",
                    "details": "Set ECOWITT_APPLICATION_KEY and ECOWITT_API_KEY as environment variables.",
                }
            ),
            500,
        )

    if not mac and not imei:
        return (
            jsonify(
                {
                    "error": "missing_server_configuration",
                    "details": "Set ECOWITT_MAC or ECOWITT_IMEI as an environment variable.",
                }
            ),
            500,
        )

    params: dict[str, str] = {
        "application_key": application_key,
        "api_key": api_key,
    }
    if mac:
        params["mac"] = mac
    if imei:
        params["imei"] = imei

    # Allow optional query passthrough for convenience (does not include secrets).
    passthrough_keys = [
        "call_back",
        "temp_unitid",
        "pressure_unitid",
        "wind_speed_unitid",
        "rainfall_unitid",
        "solar_irradiance_unitid",
        "capacity_unitid",
    ]
    for key in passthrough_keys:
        value = request.args.get(key)
        if value is not None and value != "":
            params[key] = value

    url = "https://api.ecowitt.net/api/v3/device/real_time"
    try:
        resp = requests.get(url, params=params, timeout=20)
        resp.raise_for_status()
        return jsonify(resp.json())
    except requests.RequestException as exc:
        # Don't include exception text in the response; it can contain the full URL.
        print("Ecowitt request failed:", repr(exc))
        return jsonify({"error": "ecowitt_request_failed"}), 502
    except ValueError:
        # JSON decode error
        return (
            jsonify({"error": "ecowitt_invalid_response", "details": "Non-JSON response"}),
            502,
        )


@app.route("/")
def home():
    return "Ecowitt receiver running", 200


if __name__ == "__main__":
    # Gunicorn is used on Railway (Linux). On Windows, run the built-in dev server.
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
