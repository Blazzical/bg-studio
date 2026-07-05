#!/usr/bin/env bash
# BG Studio — launch the system-tray icon (Linux / macOS).
#
# Shows the orange "BGS" icon in your panel/menu bar with a right-click menu
# (open editor / combiner, check for updates, restart, quit). It starts the
# local server itself, or attaches to one that's already running.
#
# Self-healing: installs the tiny Python deps (pystray, Pillow) on first run if
# they're missing, and picks a tray backend that works on your desktop — so a
# meme maker never has to touch pip.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BGS_PORT="${BGS_PORT:-8899}"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "BG Studio: Python 3 is required but was not found." >&2
  exit 1
fi

# 1) Make sure pystray + Pillow are importable; install to the user site if not.
if ! "$PY" -c 'import pystray, PIL' >/dev/null 2>&1; then
  echo "BG Studio: installing tray dependencies (one time)…"
  "$PY" -m pip install --user --quiet pystray Pillow >/dev/null 2>&1 || {
    echo "BG Studio: couldn't install pystray/Pillow automatically." >&2
    echo "           Try:  $PY -m pip install --user pystray Pillow" >&2
    exit 1
  }
fi

# 2) Pick a tray backend. On Linux prefer the GTK AppIndicator (best on
#    Cinnamon/GNOME/KDE); if its GObject bindings aren't present, fall back to
#    the pure-X11 backend (needs python-xlib, which is pip-installable — no
#    system packages / sudo required).
if [ "$(uname -s)" = "Linux" ]; then
  has_appindicator() {
    "$PY" - <<'PYEOF' >/dev/null 2>&1
import gi
for ns in ("AyatanaAppIndicator3", "AppIndicator3"):
    try:
        gi.require_version(ns, "0.1"); __import__("gi.repository." + ns); raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(1)
PYEOF
  }
  if ! has_appindicator; then
    "$PY" -c 'import Xlib' >/dev/null 2>&1 || "$PY" -m pip install --user --quiet python-xlib >/dev/null 2>&1 || true
    export PYSTRAY_BACKEND=xorg
  fi
fi

# 3) Launch the tray. It blocks until you pick Quit from its menu.
exec "$PY" "$DIR/tray.pyw"
