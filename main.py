"""Serve the cluster dashboard and the data directory over plain HTTP.

The page does all of its work in the browser, so this only needs to hand out
static files. Any web server pointed at this directory works just as well.
"""

import argparse
import http.server
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # The data files are overwritten in place; never let a cache hide that.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # the page polls every minute; the log adds nothing


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--open", action="store_true", help="open the dashboard in a browser")
    args = ap.parse_args()

    if not (ROOT / "data").is_dir():
        print(f"warning: {ROOT / 'data'} does not exist — the dashboard will show load errors")

    handler = partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/web/"
        print(f"cluster dashboard on {url}  (ctrl-c to stop)")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
