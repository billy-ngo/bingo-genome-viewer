"""
BiNgo Genome Viewer CLI — launch the viewer from the command line.

Usage:
    bingo                    # start on default port 8000
    bingo --port 9000        # start on a custom port
    bingo --no-browser       # start without opening the browser
"""

import argparse
import os
import sys
import threading
import time
import webbrowser


def main():
    parser = argparse.ArgumentParser(
        prog="bingo",
        description="BiNgo Genome Viewer — a lightweight browser-based genomics viewer",
    )
    parser.add_argument(
        "--port", type=int, default=8000,
        help="Port to run the server on (default: 8000)",
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--no-browser", action="store_true",
        help="Don't automatically open the browser",
    )
    args = parser.parse_args()

    # Add the backend source directory to sys.path so bare imports
    # (e.g. `from state import app_state`, `from readers.bam_reader import ...`)
    # resolve correctly.
    backend_dir = os.path.join(os.path.dirname(__file__), "server")
    sys.path.insert(0, backend_dir)

    # Now import the FastAPI app (triggers backend module loading)
    from bingoviewer.server.main import app  # noqa: E402

    # Open browser after a short delay
    if not args.no_browser:
        url = f"http://{args.host}:{args.port}"
        if args.host in ("0.0.0.0",):
            url = f"http://localhost:{args.port}"

        def _open():
            time.sleep(1.5)
            webbrowser.open(url)

        threading.Thread(target=_open, daemon=True).start()

    # Run the server
    import uvicorn
    print(f"\n  BiNgo Genome Viewer running at http://localhost:{args.port}")
    print("  Press Ctrl+C to stop.\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")

    return 0
