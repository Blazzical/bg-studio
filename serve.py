#!/usr/bin/env python3
"""Tiny static server for BG Studio that disables caching.

A plain `python -m http.server` sends no cache headers, so browsers (Firefox
especially) hold on to stale app.js/style.css and you end up running old code
after edits. This sends no-store on every response so a normal reload always
fetches the current files.
"""
import http.server
import socketserver
import sys
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

# Hosts the /proxy endpoint is allowed to fetch from (for "Import from imgflip").
# Same-origin proxying means those images don't taint the canvas, so Export/Copy
# keep working. Kept to a tight allowlist so this can't be used as an open proxy.
PROXY_HOSTS = {'i.imgflip.com', 'api.imgflip.com', 'api.memegen.link'}


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
