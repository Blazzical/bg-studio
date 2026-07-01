#!/usr/bin/env python3
"""Tiny static server for BG Studio that disables caching.

A plain `python -m http.server` sends no cache headers, so browsers (Firefox
especially) hold on to stale app.js/style.css and you end up running old code
after edits. This sends no-store on every response so a normal reload always
fetches the current files.
"""
import http.server
import json
import os
import socketserver
import sys
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
SERVE_DIR = os.path.dirname(os.path.abspath(__file__))

sys.path.insert(0, os.path.join(SERVE_DIR, 'tools'))
import update as bg_update  # noqa: E402  (tools/update.py, shared with update.bat / update.sh)

# Hosts the /proxy endpoint is allowed to fetch from (for "Import from imgflip").
# Same-origin proxying means those images don't taint the canvas, so Export/Copy
# keep working. Kept to a tight allowlist so this can't be used as an open proxy.
PROXY_HOSTS = {'i.imgflip.com', 'api.imgflip.com', 'api.memegen.link'}

# /update is POST-only and requires an Origin header matching our own host, so
# a stray cross-origin fetch from another localhost app can't trigger it.
_ALLOWED_ORIGINS = {f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/proxy?'):
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path == '/update':
            return self._update()
        self.send_error(404, 'not found')

    def _update(self):
        origin = self.headers.get('Origin', '')
        if origin and origin not in _ALLOWED_ORIGINS:
            self.send_error(403, 'origin not allowed')
            return
        try:
            payload = bg_update.update(SERVE_DIR)
        except Exception as e:
            payload = {'ok': False, 'method': 'error', 'message': f'updater crashed: {e}'}
        body = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self):
        q = urllib.parse.urlparse(self.path).query
        target = urllib.parse.parse_qs(q).get('url', [''])[0]
        p = urllib.parse.urlparse(target)
        if p.scheme not in ('http', 'https') or p.hostname not in PROXY_HOSTS:
            self.send_error(403, 'host not allowed')
            return
        try:
            req = urllib.request.Request(target, headers={'User-Agent': 'BG-Studio/1.0'})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
                ctype = r.headers.get('Content-Type', 'application/octet-stream')
        except Exception as e:
            self.send_error(502, f'proxy fetch failed: {e}')
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), NoCacheHandler) as httpd:
    print(f'BG Studio (no-cache) serving on http://localhost:{PORT}/')
    httpd.serve_forever()
