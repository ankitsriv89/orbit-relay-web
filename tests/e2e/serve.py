"""No-cache static server for E2E runs.

Python's default http.server lets `js/` be cached hard enough that an edited
module keeps serving stale bytes to Playwright — the failure mode where a real
code change produces a byte-identical measurement. Cache-busting the HTML URL
does not help, because the modules are separate requests.

    python3 tests/e2e/serve.py [port]
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8932


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002 - matches base signature
        pass


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print(f'serving {os.path.realpath(ROOT)} on http://127.0.0.1:{PORT} (no-store)')
        httpd.serve_forever()
