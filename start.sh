#!/usr/bin/env bash
# BG Studio — local launcher (Linux / macOS).
# Serves this folder over HTTP (a secure context: localhost) and opens the browser.
set -euo pipefail

PORT="${1:-8899}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}/"

cd "$DIR"

# Pick a python and a browser-opener that exist on this system.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "✗ Python 3 is required but was not found. Install it and re-run." >&2
  echo "  Debian/Ubuntu: sudo apt install python3   ·   macOS: brew install python" >&2
  exit 1
fi
OPENER="$(command -v xdg-open || command -v open || true)"

echo "🪄  BG Studio"
echo "    serving:  $DIR"
echo "    open:     $URL"
echo "    (Ctrl-C to stop)"
echo

# Open the browser shortly after the server starts (non-fatal if no opener).
if [ -n "$OPENER" ]; then
  ( sleep 1; "$OPENER" "$URL" >/dev/null 2>&1 || true ) &
fi

# Foreground server (no-cache so edits are always picked up; binds local-only).
exec "$PY" "$DIR/serve.py" "$PORT"
