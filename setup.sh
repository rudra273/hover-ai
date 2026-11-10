#!/usr/bin/env bash
# One-time setup for Orbit's transcription sidecar.
set -e
cd "$(dirname "$0")"

PY=$(command -v python3.12 || command -v python3)
echo "Using Python: $PY"

if [ ! -d .venv ]; then
  echo "Creating virtualenv (.venv)…"
  "$PY" -m venv .venv
fi

echo "Installing transcription deps (mlx-whisper, numpy)…"
.venv/bin/python -m pip install --upgrade pip >/dev/null
.venv/bin/python -m pip install -r sidecar/requirements.txt

echo "✅ Done. Run the app with: npm start"
