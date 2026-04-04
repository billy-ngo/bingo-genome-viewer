"""
BiNgo Genome Viewer CLI — launch the viewer from the command line.

Usage:
    bingo                    # start on default port 8000
    bingo --port 9000        # start on a custom port
    bingo --no-browser       # start without opening the browser
    bingo --install          # create a desktop shortcut
"""

import argparse
import atexit
import json
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

_CONFIG_DIR = Path.home() / ".bingoviewer"
_LOCK_FILE = _CONFIG_DIR / "server.lock"
_FIRST_RUN_MARKER = _CONFIG_DIR / ".shortcut_prompted"


def _is_server_running(host, port):
    """Check if a BiNgo server is already listening on host:port."""
    try:
        import urllib.request
        url = f"http://{host if host != '0.0.0.0' else 'localhost'}:{port}/health"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            return data.get("status") == "ok"
    except Exception:
        return False


def _write_lock(host, port):
    """Write a lock file so other instances can find the running server."""
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _LOCK_FILE.write_text(json.dumps({"host": host, "port": port, "pid": os.getpid()}))
    except Exception:
        pass


def _remove_lock():
    """Remove the lock file on exit."""
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            # Only remove if it belongs to this process
            if data.get("pid") == os.getpid():
                _LOCK_FILE.unlink()
    except Exception:
        pass


def _read_lock():
    """Read the lock file and return (host, port) or None."""
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            return data.get("host", "127.0.0.1"), data.get("port", 8000)
    except Exception:
        pass
    return None


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

    # ── Single-instance check ──────────────────────────────────────
    # If a server is already running, just open a new browser tab and exit.
    lock = _read_lock()
    if lock:
        lock_host, lock_port = lock
        if _is_server_running(lock_host, lock_port):
            url = f"http://{'localhost' if lock_host in ('0.0.0.0', '127.0.0.1') else lock_host}:{lock_port}"
            if not args.no_browser:
                print(f"\n  BiNgo Genome Viewer is already running at {url}")
                print("  Opening a new browser tab...\n")
                webbrowser.open(url)
            else:
                print(f"\n  BiNgo Genome Viewer is already running at {url}\n")
            return 0
        else:
            # Stale lock file — server is no longer running
            try:
                _LOCK_FILE.unlink()
            except Exception:
                pass

    # Also check if the target port is already in use by our server
    if _is_server_running(args.host, args.port):
        url = f"http://{'localhost' if args.host in ('0.0.0.0', '127.0.0.1') else args.host}:{args.port}"
        if not args.no_browser:
            print(f"\n  BiNgo Genome Viewer is already running at {url}")
            print("  Opening a new browser tab...\n")
            webbrowser.open(url)
        else:
            print(f"\n  BiNgo Genome Viewer is already running at {url}\n")
        return 0

    # On first launch, offer to create a desktop shortcut
    _first_run_shortcut_prompt()

    # Add the backend source directory to sys.path so bare imports
    # (e.g. `from state import app_state`, `from readers.bam_reader import ...`)
    # resolve correctly.
    backend_dir = os.path.join(os.path.dirname(__file__), "server")
    sys.path.insert(0, backend_dir)

    # Enable auto-shutdown: the server will exit when all browser tabs close
    os.environ["BINGO_AUTO_SHUTDOWN"] = "1"

    # Now import the FastAPI app (triggers backend module loading + watchdog)
    from bingoviewer.server.main import app  # noqa: E402

    # Write lock file and register cleanup
    _write_lock(args.host, args.port)
    atexit.register(_remove_lock)

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
