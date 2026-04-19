#!/usr/bin/env python3
"""
Blog Helper — Local dev server (simulates nginx).

Serves static blog files + reverse proxies /api/ to the Go backend.

Usage:
    # Serve a blog on port 4000:
    SITE_DIR=/path/to/your-blog python3 scripts/dev-server.py

    # Serve a second blog on port 4001:
    SITE_DIR=/path/to/second-blog PORT=4001 python3 scripts/dev-server.py

    # Quick start (uses make dev):
    make dev

Environment variables:
    SITE_DIR    — Path to static blog directory (required)
    PORT        — Listen port (default: 4000)
    API_BACKEND — Blog-helper backend address (default: 127.0.0.1:9001)
"""

import http.server
import http.client
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

SITE_DIR = os.environ.get("SITE_DIR", "")
PORT = int(os.environ.get("PORT", "4000"))
API_BACKEND = os.environ.get("API_BACKEND", "127.0.0.1:9001")


class DevHandler(http.server.SimpleHTTPRequestHandler):
    """Static file server + /api/ reverse proxy."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE_DIR, **kwargs)

    # ----- Reverse proxy for /api/ -----

    def _proxy(self):
        # Read request body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else None

        # Use http.client directly to avoid auto-redirect (preserves Set-Cookie on 303)
        try:
            host, _, port = API_BACKEND.partition(":")
            conn = http.client.HTTPConnection(host, int(port) if port else 80, timeout=10)

            # Build headers
            hdrs = {}
            for header in ("Content-Type", "Origin", "Referer", "User-Agent", "Cookie",
                           "Accept", "Accept-Encoding", "Accept-Language"):
                val = self.headers.get(header)
                if val:
                    hdrs[header] = val
            client_ip = self.client_address[0]
            hdrs["X-Real-IP"] = client_ip
            hdrs["X-Forwarded-For"] = client_ip
            hdrs["Host"] = self.headers.get("Host", f"localhost:{PORT}")

            conn.request(self.command, self.path, body=body, headers=hdrs)
            resp = conn.getresponse()
            resp_body = resp.read()
            conn.close()

            # Rewrite Location header to point to dev proxy, not backend
            self.send_response(resp.status)
            for key, val in resp.getheaders():
                k = key.lower()
                if k in ("transfer-encoding", "connection"):
                    continue
                # Rewrite redirect Location from backend to proxy
                if k == "location":
                    val = val.replace(f"http://{API_BACKEND}", "")
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            msg = f'{{"ok":false,"error":{{"code":"BAD_GATEWAY","message":"Backend unavailable: {e}"}}}}'
            self.wfile.write(msg.encode())

    # ----- Route dispatch -----

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self.send_response(405)
            self.end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            origin = self.headers.get("Origin", "")
            self.send_response(204)
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()
        else:
            self.send_response(405)
            self.end_headers()

    # ----- Disable cache for dev -----

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    # ----- Better MIME types -----

    def guess_type(self, path):
        _, ext = os.path.splitext(path)
        if ext == ".js":
            return "application/javascript"
        if ext == ".css":
            return "text/css"
        if ext == ".json":
            return "application/json"
        return super().guess_type(path)

    # ----- Cleaner log -----

    def log_message(self, fmt, *args):
        if not args:
            return
        msg = str(args[0])
        parts = msg.split()
        path = parts[1] if len(parts) > 1 else ""
        if path.startswith("/api/"):
            tag = "\033[36m PROXY\033[0m"
        else:
            tag = "\033[90m STATIC\033[0m"
        sys.stderr.write(f"  {tag}  {fmt % args}\n")


def copy_sdk_if_needed():
    """Auto-copy blog-helper.js into SITE_DIR/asset/js/ if missing."""
    sdk_in_site = os.path.join(SITE_DIR, "asset", "js", "blog-helper.js")
    sdk_source = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "sdk", "blog-helper.js",
    )
    if not os.path.exists(sdk_in_site) and os.path.exists(sdk_source):
        os.makedirs(os.path.dirname(sdk_in_site), exist_ok=True)
        import shutil
        shutil.copy2(sdk_source, sdk_in_site)
        print(f"  \033[32mSDK\033[0m  Copied blog-helper.js → asset/js/")
        return True
    if os.path.exists(sdk_in_site) and os.path.exists(sdk_source):
        # Always sync latest SDK during dev
        import shutil
        import filecmp
        if not filecmp.cmp(sdk_source, sdk_in_site, shallow=False):
            shutil.copy2(sdk_source, sdk_in_site)
            print(f"  \033[32mSDK\033[0m  Updated blog-helper.js → asset/js/")
            return True
    return False


def main():
    global SITE_DIR

    if not SITE_DIR:
        # Try default: MWeb3 thinkycx.me
        mweb_default = os.path.expanduser(
            "~/Library/Containers/com.coderforart.MWeb3/Data/Documents/themes/Site/thinkycx.me"
        )
        if os.path.isdir(mweb_default):
            SITE_DIR = mweb_default
        else:
            print("\033[31mError:\033[0m SITE_DIR environment variable is required.\n")
            print("Usage:")
            print("  SITE_DIR=/path/to/blog python3 scripts/dev-server.py\n")
            print("Examples:")
            print("  # Primary site (MWeb3)")
            print('  SITE_DIR="$HOME/Library/Containers/com.coderforart.MWeb3/Data/Documents/themes/Site/your-site" \\')
            print("    python3 scripts/dev-server.py\n")
            print("  # Second site on port 4001")
            print('  SITE_DIR="/path/to/second-site" \\')
            print("    PORT=4001 python3 scripts/dev-server.py")
            sys.exit(1)

    if not os.path.isdir(SITE_DIR):
        print(f"\033[31mError:\033[0m SITE_DIR does not exist: {SITE_DIR}")
        sys.exit(1)

    index = os.path.join(SITE_DIR, "index.html")
    if not os.path.exists(index):
        print(f"\033[33mWarning:\033[0m No index.html found in {SITE_DIR}")

    copy_sdk_if_needed()

    # Pretty-print truncated path
    display_dir = SITE_DIR.replace(os.path.expanduser("~"), "~")

    print()
    print("  ┌──────────────────────────────────────────────────┐")
    print("  │  \033[1mBlog Helper Dev Server\033[0m                          │")
    print("  ├──────────────────────────────────────────────────┤")
    print(f"  │  Blog:    \033[4mhttp://localhost:{PORT}\033[0m{' ' * (21 - len(str(PORT)))}│")
    print(f"  │  API:     \033[4mhttp://localhost:{PORT}/api/v1/health\033[0m   │")
    print(f"  │  Backend: {API_BACKEND:<39s}│")
    print("  ├──────────────────────────────────────────────────┤")
    dir_line = display_dir if len(display_dir) <= 39 else "..." + display_dir[-(39-3):]
    print(f"  │  {dir_line:<48s}│")
    print("  └──────────────────────────────────────────────────┘")
    print()
    print("  Make sure the Go backend is running in another terminal:")
    print(f"    \033[1mmake run\033[0m")
    print()

    server = http.server.HTTPServer(("0.0.0.0", PORT), DevHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
