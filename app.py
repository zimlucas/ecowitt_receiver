import os

from flask import Flask, request

app = Flask(__name__)


@app.route("/ecowitt", methods=["GET", "POST"])
def receive_ecowitt():
    data = request.values.to_dict()
    print("Received data:", data)
    return "OK", 200


@app.route("/")
def home():
    return "Ecowitt receiver running", 200


if __name__ == "__main__":
    # Gunicorn is used on Railway (Linux). On Windows, run the built-in dev server.
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
