#!/usr/bin/env python3
"""BG Studio — system tray runner.

Runs serve.py as a hidden subprocess and shows a BGS icon in the Windows
notification area (or macOS menu bar / Linux system tray) with a right-click
menu: open the editor / combiner in a browser, check for updates, restart
the server, quit.

Requires: pystray, Pillow.
Launch with pythonw so there's no console window — see start-tray.bat.
"""
from __future__ import annotations

import os
import sys
import subprocess
import threading
import time
import webbrowser

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('BGS_PORT', 8899))

# Fail fast (with a message box) if pystray isn't installed. Without a console
# a bare ImportError would just silently die on pythonw.
try:
    import pystray
    from PIL import Image
except ImportError as e:
    msg = (
        "BG Studio tray needs the 'pystray' and 'Pillow' packages.\n\n"
        f"Missing: {e}\n\nInstall with:\n    pip install pystray Pillow"
    )
    if sys.platform == 'win32':
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "BG Studio - missing dependency", 0x10)
    else:
        sys.stderr.write(msg + "\n")
    sys.exit(1)

# Shared updater — same code path as the CLI and the /update endpoint.
sys.path.insert(0, os.path.join(DIR, 'tools'))
import update as bg_update   # noqa: E402


class BGStudioTray:
    def __init__(self):
        self.server_proc: subprocess.Popen | None = None
        self.icon: pystray.Icon | None = None

    # ---- server subprocess management ------------------------------------

    def _port_serving(self) -> bool:
        """True if something is already listening on our port (e.g. a systemd
        service, or another tray instance) — so we don't start a duplicate."""
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            return s.connect_ex(('127.0.0.1', PORT)) == 0

    def start_server(self) -> None:
        if self.server_proc is not None and self.server_proc.poll() is None:
            return
        if self._port_serving():
            return  # already served by someone else — just attach to it
        creationflags = 0
        if sys.platform == 'win32':
            # No stray console window.
            creationflags = subprocess.CREATE_NO_WINDOW
        # pythonw can run serve.py just fine — it's an HTTP server, doesn't
        # need stdio. Use the same interpreter we're running under so we
        # inherit the venv / user-site pystray install.
        self.server_proc = subprocess.Popen(
            [sys.executable, os.path.join(DIR, 'serve.py'), str(PORT)],
            cwd=DIR,
            creationflags=creationflags,
        )

    def stop_server(self) -> None:
        p = self.server_proc
        if p is None:
            return
        try:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        except Exception:
            pass
        self.server_proc = None

    # ---- menu actions ----------------------------------------------------

    def _notify(self, message: str, title: str = 'BG Studio') -> None:
        try:
            self.icon.notify(message, title)
        except Exception:
            pass

    def open_editor(self, icon=None, item=None) -> None:
        webbrowser.open(f'http://localhost:{PORT}/')

    def open_combiner(self, icon=None, item=None) -> None:
        webbrowser.open(f'http://localhost:{PORT}/combiner.html')

    def check_update(self, icon=None, item=None) -> None:
        # Run off the UI thread so the menu stays responsive.
        def worker():
            self._notify('Checking for updates…')
            try:
                result = bg_update.update(DIR)
            except Exception as e:
                self._notify(f'Update failed: {e}')
                return
            msg = result.get('message', '') or ''
            if result.get('ok'):
                if 'up to date' in msg.lower():
                    self._notify('Already up to date.')
                else:
                    self._notify('Updated. Restarting server…')
                    self.stop_server()
                    time.sleep(0.4)
                    self.start_server()
            else:
                first_line = (msg.splitlines()[0] if msg else 'unknown error')[:200]
                self._notify(f'Update failed: {first_line}')
        threading.Thread(target=worker, daemon=True).start()

    def restart_server(self, icon=None, item=None) -> None:
        self.stop_server()
        time.sleep(0.4)
        self.start_server()
        self._notify('Server restarted.')

    def quit(self, icon=None, item=None) -> None:
        self.stop_server()
        if self.icon is not None:
            self.icon.stop()

    # ---- main ------------------------------------------------------------

    def run(self) -> None:
        icon_path = os.path.join(DIR, 'favicon.ico')
        if os.path.exists(icon_path):
            image = Image.open(icon_path)
        else:
            image = Image.new('RGB', (64, 64), (255, 122, 26))

        menu = pystray.Menu(
            pystray.MenuItem('Open BG Studio', self.open_editor, default=True),
            pystray.MenuItem('Open Combiner', self.open_combiner),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Check for updates…', self.check_update),
            pystray.MenuItem('Restart server', self.restart_server),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Quit', self.quit),
        )
        self.icon = pystray.Icon('bg-studio', image, 'BG Studio', menu)
        self.start_server()
        # Give the server a beat to bind the port before the first click can
        # reach it. Not strictly required, but avoids "connection refused" on
        # a very fast Open-BG-Studio click.
        threading.Timer(0.6, lambda: None).start()
        self.icon.run()   # blocking; returns when self.quit() calls stop()


if __name__ == '__main__':
    BGStudioTray().run()
