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


# ── Fast instance detection ────────────────────────────────────────
def _pid_alive(pid):
    """Check whether a process with *pid* exists (instant, no I/O)."""
    try:
        os.kill(pid, 0)          # signal 0 = existence check
        return True
    except (OSError, ProcessLookupError, PermissionError):
        return False


def _http_check(host, port, timeout=0.5):
    """Quick GET /health; returns True only if our server answers."""
    try:
        import urllib.request
        url = f"http://{'localhost' if host in ('0.0.0.0', '127.0.0.1') else host}:{port}/health"
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read()).get("status") == "ok"
    except Exception:
        return False


def _check_existing_server(host, port):
    """Return the URL of an already-running server, or None."""
    # 1. Check lock file (PID → HTTP — avoids slow timeout when nothing is running)
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            lock_host = data.get("host", "127.0.0.1")
            lock_port = data.get("port", 8000)
            lock_pid = data.get("pid")
            if lock_pid and _pid_alive(lock_pid) and _http_check(lock_host, lock_port):
                h = "localhost" if lock_host in ("0.0.0.0", "127.0.0.1") else lock_host
                return f"http://{h}:{lock_port}"
            # Stale lock — remove it
            _LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    # 2. Quick port probe (catches servers started outside our CLI)
    if _http_check(host, port):
        h = "localhost" if host in ("0.0.0.0", "127.0.0.1") else host
        return f"http://{h}:{port}"

    return None


# ── Lock file helpers ──────────────────────────────────────────────
def _write_lock(host, port):
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _LOCK_FILE.write_text(json.dumps({"host": host, "port": port, "pid": os.getpid()}))
    except Exception:
        pass


def _remove_lock():
    try:
        if _LOCK_FILE.exists():
            data = json.loads(_LOCK_FILE.read_text())
            if data.get("pid") == os.getpid():
                _LOCK_FILE.unlink()
    except Exception:
        pass


# ── First-run shortcut prompt ─────────────────────────────────────
def _first_run_shortcut_prompt():
    if _FIRST_RUN_MARKER.exists():
        return
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _FIRST_RUN_MARKER.write_text("prompted")
    except Exception:
        return
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
        pass


# ── Browser opener (polls server until ready) ─────────────────────
def _open_when_ready(url, timeout=8):
    """Poll the health endpoint and open the browser as soon as the server responds."""
    import urllib.request
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(f"{url}/health", timeout=0.5)
            break
        except Exception:
            time.sleep(0.15)
    webbrowser.open(url)


# ── Entry point ───────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        prog="bingo",
        description="BiNgo Genome Viewer — a lightweight browser-based genomics viewer",
    )
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host (default: 127.0.0.1)")
    parser.add_argument("--no-browser", action="store_true", help="Don't open the browser")
    parser.add_argument("--install", action="store_true", help="Create a desktop shortcut")
    args = parser.parse_args()

    if args.install:
        from bingoviewer.install_shortcut import main as install_main
        install_main()
        return 0

    # ── Single-instance check (fast: PID probe → quick HTTP) ──────
    existing = _check_existing_server(args.host, args.port)
    if existing:
        if not args.no_browser:
            webbrowser.open(existing)
        return 0

    # First launch — offer desktop shortcut
    _first_run_shortcut_prompt()

    # Resolve the URL the browser will open
    url = f"http://{'localhost' if args.host in ('0.0.0.0',) else args.host}:{args.port}"

    # Start browser-opener thread BEFORE heavy imports so it can poll
    # for server readiness in parallel with import + uvicorn startup.
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    # ── Heavy imports (FastAPI, Pydantic, Starlette) ──────────────
    backend_dir = os.path.join(os.path.dirname(__file__), "server")
    sys.path.insert(0, backend_dir)
    os.environ["BINGO_AUTO_SHUTDOWN"] = "1"

    from bingoviewer.server.main import app  # noqa: E402

    # Write lock file and register cleanup
    _write_lock(args.host, args.port)
    atexit.register(_remove_lock)

    # ── Start server ──────────────────────────────────────────────
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0
