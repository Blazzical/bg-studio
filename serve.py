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

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', PORT), NoCacheHandler) as httpd:
    print(f'BG Studio (no-cache) serving on http://localhost:{PORT}/')
    httpd.serve_forever()
