#!/usr/bin/env bash
# BG Studio — installer for Linux / macOS.
#
# What it does (no root required):
#   • checks that Python 3 is available
#   • makes the launchers executable
#   • adds a desktop menu entry (Linux)
#   • optionally enables autostart on login/boot via a systemd *user* service
#
# Usage:
#   ./install.sh                 # set up + add a menu entry
#   ./install.sh --autostart     # also start now and on every boot (Linux/systemd)
#   ./install.sh --port 9001     # use a different port (default 8899)
#   ./install.sh --uninstall     # remove menu entry + autostart service
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8899
AUTOSTART=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --autostart) AUTOSTART=1 ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$SERVICE_DIR/bg-studio.service"
DESKTOP="$HOME/.local/share/applications/bg-studio.desktop"

say() { printf '  %s\n' "$*"; }

if [ "$UNINSTALL" = 1 ]; then
  echo "🪄  Uninstalling BG Studio integration (files in $DIR are left untouched)…"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now bg-studio.service >/dev/null 2>&1 || true
  fi
  rm -f "$SERVICE" "$DESKTOP"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
  say "Removed menu entry and autostart service. Done."
  exit 0
fi

echo "🪄  Installing BG Studio from: $DIR"

# 1) Python check.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "✗ Python 3 is required but was not found." >&2
  echo "  Debian/Ubuntu: sudo apt install python3   ·   Fedora: sudo dnf install python3" >&2
  echo "  macOS:         brew install python" >&2
  exit 1
fi
say "Python:   $PY ($("$PY" --version 2>&1))"

# 2) Make launchers executable.
chmod +x "$DIR/start.sh" "$DIR/serve.py" 2>/dev/null || true

# 3) Desktop menu entry (Linux desktops; harmless elsewhere).
if [ "$(uname -s)" = "Linux" ]; then
  mkdir -p "$(dirname "$DESKTOP")"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=BG Studio
Comment=Local meme generator + background remover
Exec=$DIR/start.sh $PORT
Terminal=true
Categories=Graphics;Photography;
EOF
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true
  say "Menu:     added 'BG Studio' to your applications menu"
fi

# 4) Optional autostart via a systemd user service (Linux).
if [ "$AUTOSTART" = 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "⚠ --autostart needs systemd (not found); skipping. You can still run ./start.sh." >&2
  else
    mkdir -p "$SERVICE_DIR"
    cat > "$SERVICE" <<EOF
[Unit]
Description=BG Studio — local meme & background-removal image editor
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$PY $DIR/serve.py $PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now bg-studio.service
    # Keep it running even when you're not logged in (best-effort; may prompt for password).
    loginctl enable-linger "$USER" >/dev/null 2>&1 || \
      say "(tip: 'sudo loginctl enable-linger $USER' to keep it running across reboots without login)"
    say "Autostart: enabled — serving now on http://localhost:$PORT/ and on every boot"
  fi
fi

echo
echo "✅  Done."
echo "    Start it:   $DIR/start.sh        (then it opens http://localhost:$PORT/)"
[ "$AUTOSTART" = 1 ] && echo "    It's already running at http://localhost:$PORT/"
echo "    Autostart:  $DIR/install.sh --autostart"
echo "    Remove:     $DIR/install.sh --uninstall"
