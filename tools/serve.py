#!/usr/bin/env python3
"""Local static server with the cross-origin isolation headers the game needs (SharedArrayBuffer)."""
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # tools only: the game page uploads rb/scripts.iseq here after rgss_build_iseq (see rb/loader.rb)
    def do_PUT(self):
        if self.path.split('?')[0] != '/rb/scripts.iseq':
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers['Content-Length']))
        with open('rb/scripts.iseq', 'wb') as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
