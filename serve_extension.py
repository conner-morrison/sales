"""
Serve the extension folder as a zip, so sync.ps1 on the Windows PC can fetch it
without a login.

    python3 serve_extension.py              # port 8770, token from .sync_token

Only one thing is served: GET /api/extension/download?token=<token>, a zip whose top
folder is "extension/". Everything else, and any request without the token, is a 404,
so the address alone gives nothing away. The token is not encryption -- this is plain
HTTP, and anyone who sees the request sees the token.

The zip is built fresh on every request, so an edit here is picked up on the next sync
with nothing to restart.
"""

import hmac
import io
import os
import secrets
import sys
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
EXTENSION = HERE / "extension"
TOKEN_FILE = HERE / ".sync_token"
PORT = int(os.environ.get("PORT", "8770"))


def load_token() -> str:
    """The token, created on first run and kept so sync.ps1 keeps working."""
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_urlsafe(24))
        TOKEN_FILE.chmod(0o600)
    return TOKEN_FILE.read_text().strip()


def build_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(EXTENSION.rglob("*")):
            if path.is_file():
                z.write(path, "extension/" + path.relative_to(EXTENSION).as_posix())
    return buf.getvalue()


TOKEN = load_token()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        given = parse_qs(url.query).get("token", [""])[0]
        if url.path != "/api/extension/download" or not hmac.compare_digest(given, TOKEN):
            self.send_error(404)
            return
        body = build_zip()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # The token is in the query string; keep it out of the log.
        line = "%s %s\n" % (self.address_string(), fmt % args)
        sys.stderr.write(line.replace(TOKEN, "<token>"))


if __name__ == "__main__":
    print(f"serving {EXTENSION} on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
