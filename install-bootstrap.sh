#!/usr/bin/env bash
# BG Studio — one-liner bootstrap installer for Linux / macOS.
#
# What it does:
#   * downloads the latest bg-studio tarball from GitHub (no git required)
#   * extracts to a target directory (default: $HOME/bg-studio)
#   * runs install.sh to add a desktop menu entry
#
# Usage (no clone required):
#   curl -sSL https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.sh | bash
#
# With options (download the script first so you can pass flags):
#   curl -sSL https://.../install-bootstrap.sh -o bs.sh && bash bs.sh --dir /opt/bg-studio --autostart
set -euo pipefail

DIR="$HOME/bg-studio"
AUTOSTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a path}"; shift ;;
    --autostart) AUTOSTART=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

TARBALL_URL="https://api.github.com/repos/Blazzical/bg-studio/tarball/main"

echo "🪄  BG Studio bootstrap"
echo "    target:  $DIR"
echo

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "✗ Python 3 is required but was not found." >&2
  echo "  Debian/Ubuntu: sudo apt install python3   ·   Fedora: sudo dnf install python3   ·   macOS: brew install python" >&2
  exit 1
fi
echo "    Python:  $PY ($("$PY" --version 2>&1))"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t bgs-bootstrap)"
trap 'rm -rf "$TMP"' EXIT

echo "    download: $TARBALL_URL"
if command -v curl >/dev/null 2>&1; then
  curl -sSL -o "$TMP/bg-studio.tar.gz" "$TARBALL_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/bg-studio.tar.gz" "$TARBALL_URL"
else
  echo "✗ neither curl nor wget is available." >&2
  exit 1
fi

mkdir -p "$DIR"
echo "    extract: $DIR"
# GitHub tarballs wrap in Blazzical-bg-studio-<sha>/ — strip that prefix.
tar -xzf "$TMP/bg-studio.tar.gz" -C "$DIR" --strip-components=1

INSTALLER="$DIR/install.sh"
if [ ! -x "$INSTALLER" ] && [ -f "$INSTALLER" ]; then chmod +x "$INSTALLER"; fi
if [ ! -f "$INSTALLER" ]; then
  echo "✗ install.sh not found in extracted tree at $DIR" >&2
  exit 1
fi

echo
echo "    Handing off to install.sh..."
echo
if [ "$AUTOSTART" = 1 ]; then
  "$INSTALLER" --autostart
else
  "$INSTALLER"
fi
