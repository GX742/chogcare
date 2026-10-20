"""Loopback-only, bounded live window for the mobile transcoder."""
import http.client
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOURCE = "http://127.0.0.1:8080/hls/0/"
PORT = 8091


def live_window(text, keep=3):
    lines = text.splitlines()
    if not lines or lines[0] != "#EXTM3U" or len(text) > 65536:
        raise ValueError("Invalid source playlist")
    sequence = target = None
    segments, pending = [], []
    for line in lines[1:]:
        if not line:
            continue
        if re.fullmatch(r"#EXT-X-MEDIA-SEQUENCE:[0-9]{1,15}", line):
            if sequence is not None:
                raise ValueError("Duplicate sequence")
            sequence = int(line.split(":")[1])
        elif re.fullmatch(r"#EXT-X-TARGETDURATION:[1-5]", line):
            target = int(line.split(":")[1])
        elif re.fullmatch(r"#EXT-X-VERSION:[1-9]", line) or line == "#EXT-X-INDEPENDENT-SEGMENTS":
            continue
        elif re.fullmatch(r"#EXTINF:[0-5](?:\.[0-9]{1,9})?,", line):
            if pending:
                raise ValueError("Incomplete source segment")
            pending.append(line)
        elif re.fullmatch(r"#EXT-X-PROGRAM-DATE-TIME:[0-9T:+.Z-]{15,40}", line) and pending:
            pending.append(line)
        # Owncast session IDs use URL-safe characters, including '-' and '_'.
        # Keep a filename-only allowlist: accepting a valid new session must
        # never allow an upstream host, path traversal, query or encoded path.
        elif re.fullmatch(r"stream-[A-Za-z0-9_-]{1,64}-[0-9]{1,15}\.ts", line) and pending:
            segments.append([*pending, SOURCE + line])
            pending = []
        else:
            raise ValueError("Unsupported source playlist")
    if sequence is None or target is None or pending or not segments or len(segments) > 128 or not 1 <= keep <= 6:
        raise ValueError("Incomplete source playlist")
    start = max(0, len(segments) - keep)
    header = ["#EXTM3U", "#EXT-X-VERSION:6", f"#EXT-X-TARGETDURATION:{target}",
              f"#EXT-X-MEDIA-SEQUENCE:{sequence + start}", "#EXT-X-INDEPENDENT-SEGMENTS"]
    return "\n".join([*header, *(line for segment in segments[start:] for line in segment)]) + "\n"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class LivePlaylistSource:
    """A short upstream hiccup must not terminate the live transcoder."""

    def __init__(self, opener=None, now=time.monotonic, pause=time.sleep):
        self.opener = opener
        self.now = now
        self.pause = pause
        self.cached_body = None
        self.cached_at = 0
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            opener = self.opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            last_problem = None
            for attempt in range(3):
                try:
                    with opener.open(SOURCE + "stream.m3u8", timeout=1) as response:
                        raw = response.read(65537)
                    # Validation errors never use stale data or another URL.
                    body = live_window(raw.decode("utf-8")).encode("utf-8")
                    self.cached_body, self.cached_at = body, self.now()
                    return body
                except urllib.error.HTTPError as problem:
                    if problem.code not in (408, 425, 429, 500, 502, 503, 504):
                        raise
                    problem.close()
                    last_problem = problem
                except (OSError, http.client.HTTPException) as problem:
                    last_problem = problem
                # The cache contains only the fixed source's validated three-
                # segment window. It cannot mask an outage beyond three seconds.
                age = self.now() - self.cached_at
                if self.cached_body is not None and 0 <= age <= 3:
                    return self.cached_body
                if attempt < 2:
                    self.pause(0.1 * (attempt + 1))
            raise last_problem


playlist_source = LivePlaylistSource()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path != "/stream.m3u8" or self.headers.get("Host") != f"127.0.0.1:{PORT}":
            self.send_error(404)
            return
        try:
            body = playlist_source.load()
        except (OSError, http.client.HTTPException, ValueError, UnicodeError):
            self.send_error(503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
