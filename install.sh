#!/usr/bin/env bash
# BG Studio — installer for Linux / macOS.
#
# What it does (no root required):
#   • checks that Python 3 is available
#   • makes the launchers executable
#   • installs the little tray deps (pystray, Pillow) and shows the "BGS" icon
#     in your panel/menu bar — now and on every login (Linux)
#   • adds a desktop menu entry (Linux)
#   • optionally enables autostart on login/boot via a systemd *user* service
#
# Usage:
#   ./install.sh                 # set up + tray icon + menu entry
#   ./install.sh --no-tray       # skip the tray icon (menu entry only)
#   ./install.sh --autostart     # also run a headless server on every boot (systemd)
#   ./install.sh --port 9001     # use a different port (default 8899)
#   ./install.sh --uninstall     # remove tray, menu entry + autostart service
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8899
AUTOSTART=0
UNINSTALL=0
TRAY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --autostart) AUTOSTART=1 ;;
    --no-tray) TRAY=0 ;;
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
DESKTOP_UPDATE="$HOME/.local/share/applications/bg-studio-update.desktop"
AUTOSTART_DESKTOP="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/bg-studio-tray.desktop"
ICON="$DIR/icon-192.png"

say() { printf '  %s\n' "$*"; }

if [ "$UNINSTALL" = 1 ]; then
  echo "🪄  Uninstalling BG Studio integration (files in $DIR are left untouched)…"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now bg-studio.service >/dev/null 2>&1 || true
  fi
  pkill -f "$DIR/tray.pyw" >/dev/null 2>&1 || true
  rm -f "$SERVICE" "$DESKTOP" "$DESKTOP_UPDATE" "$AUTOSTART_DESKTOP"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
  say "Removed tray icon, menu entry and autostart service. Done."
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
chmod +x "$DIR/start.sh" "$DIR/update.sh" "$DIR/serve.py" "$DIR/start-tray.sh" 2>/dev/null || true

# 3) Tray deps (Linux/macOS) — best-effort now so the first launch is instant;
#    start-tray.sh self-heals if this is skipped or fails.
if [ "$TRAY" = 1 ] && { [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; }; then
  if ! "$PY" -c 'import pystray, PIL' >/dev/null 2>&1; then
    say "Deps:     installing tray dependencies (pystray, Pillow)…"
    "$PY" -m pip install --user --quiet pystray Pillow >/dev/null 2>&1 || \
      say "(couldn't preinstall — start-tray.sh will retry automatically on first launch)"
  fi
fi

# 4) Desktop menu entries + tray icon (Linux desktops; harmless elsewhere).
if [ "$(uname -s)" = "Linux" ]; then
  mkdir -p "$(dirname "$DESKTOP")"
  if [ "$TRAY" = 1 ]; then MAIN_EXEC="$DIR/start-tray.sh"; MAIN_TERM=false
  else MAIN_EXEC="$DIR/start.sh $PORT"; MAIN_TERM=true; fi
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=BG Studio
Comment=Local meme generator + background remover
Exec=$MAIN_EXEC
Icon=$ICON
Terminal=$MAIN_TERM
Categories=Graphics;Photography;
EOF
  cat > "$DESKTOP_UPDATE" <<EOF
[Desktop Entry]
Type=Application
Name=BG Studio - Update
Comment=Pull the latest BG Studio from GitHub
Exec=$DIR/update.sh
Icon=$ICON
Terminal=true
Categories=Graphics;Photography;
EOF
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true
  say "Menu:     added 'BG Studio' to your applications menu"

  # Tray: autostart on login + launch it right now.
  if [ "$TRAY" = 1 ]; then
    mkdir -p "$(dirname "$AUTOSTART_DESKTOP")"
    cat > "$AUTOSTART_DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=BG Studio (tray)
Comment=BG Studio system-tray icon
Exec=$DIR/start-tray.sh
Icon=$ICON
Terminal=false
X-GNOME-Autostart-enabled=true
Categories=Graphics;
EOF
    if pgrep -f "$DIR/tray.pyw" >/dev/null 2>&1; then
      say "Tray:     already running — BGS icon is in your panel (also starts on login)"
    else
      ( setsid "$DIR/start-tray.sh" >/dev/null 2>&1 & ) || true
      say "Tray:     BGS icon starting in your panel now, and on every login"
    fi
  fi
fi

# 5) Optional headless server autostart via a systemd user service (Linux).
#    Coexists with the tray (the tray attaches to this server via the port).
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
if [ "$TRAY" = 1 ] && [ "$(uname -s)" = "Linux" ]; then
  echo "    🎉 Look for the orange BGS icon in your panel/system tray."
  echo "       Right-click it to open BG Studio, the Combiner, check for updates, or quit."
fi
echo "    Open it:    $DIR/start-tray.sh    (or the 'BG Studio' menu entry)"
echo "    No tray:    $DIR/start.sh         (just opens http://localhost:$PORT/)"
[ "$AUTOSTART" = 1 ] && echo "    Server:     already running at http://localhost:$PORT/"
echo "    Update:     $DIR/update.sh        (pulls the latest from GitHub)"
echo "    Remove:     $DIR/install.sh --uninstall"
