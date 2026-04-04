"""
BiNgo Genome Viewer CLI — launch the viewer from the command line.

Usage:
    bingo                    # start on default port 8000
    bingo --port 9000        # start on a custom port
    bingo --no-browser       # start without opening the browser
    bingo --install          # create a desktop shortcut
"""

import argparse
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

_CONFIG_DIR = Path.home() / ".bingoviewer"
_FIRST_RUN_MARKER = _CONFIG_DIR / ".shortcut_prompted"


def _first_run_shortcut_prompt():
    """On first ever launch, ask the user if they want a desktop shortcut."""
    # Already prompted before — skip silently
    if _FIRST_RUN_MARKER.exists():
        return

    # Mark as prompted immediately so it never asks again, even on failure
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _FIRST_RUN_MARKER.write_text("prompted")
    except Exception:
        return  # can't write marker — skip rather than ask every time

    # Show a yes/no dialog via tkinter
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()

        answer = messagebox.askyesno(
            "BiNgo Genome Viewer",
            "Would you like to create a desktop shortcut for BiNgo Genome Viewer?\n\n"
            "You can also do this later with:  bingo --install",
        )
        root.destroy()

        if answer:
            from bingoviewer.install_shortcut import main as install_main
            install_main()
    except Exception:
        pass  # tkinter not available or dialog failed — continue silently


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
    parser.add_argument(
        "--install", action="store_true",
        help="Create a desktop shortcut instead of starting the server",
    )
    args = parser.parse_args()

    if args.install:
        from bingoviewer.install_shortcut import main as install_main
        install_main()
        return 0

    # On first launch, offer to create a desktop shortcut
    _first_run_shortcut_prompt()

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
