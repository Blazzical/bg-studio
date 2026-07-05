#!/usr/bin/env bash
# BG Studio — pull the latest from GitHub.
# Delegates to tools/update.py so the CLI, the in-app button, and any future
# updater surface all share one code path.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo
echo "  BG Studio — checking for updates"
echo "    in:  $DIR"
echo

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "✗ Python 3 is required but was not found."
  echo "  Debian/Ubuntu: sudo apt install python3   ·   Fedora: sudo dnf install python3"
  echo "  macOS:         brew install python"
  echo
  read -rp "Press Enter to close…" _ || true
  exit 1
fi

if "$PY" "$DIR/tools/update.py" "$DIR"; then
  echo
  echo "Restart BG Studio to pick up any server-side changes."
else
  echo
  echo "✗ Update failed. See the message above for details."
fi

echo
read -rp "Press Enter to close…" _ || true
