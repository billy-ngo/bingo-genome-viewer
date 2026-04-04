"""
BiNgo Genome Viewer CLI — launch the viewer from the command line.

Usage:
    bingo                    # start on default port 8000
    bingo --port 9000        # start on a custom port
    bingo --no-browser       # start without opening the browser
    bingo --install          # create a desktop shortcut
    bingo --update           # check for updates and install if available
    bingo --no-update        # skip the automatic update check
"""

import argparse
import atexit
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

_CONFIG_DIR = Path.home() / ".bingoviewer"
_LOCK_FILE = _CONFIG_DIR / "server.lock"
_FIRST_RUN_MARKER = _CONFIG_DIR / ".shortcut_prompted"
_UPDATE_CHECK_FILE = _CONFIG_DIR / ".last_update_check"

# Minimum seconds between automatic update checks (1 hour)
_UPDATE_CHECK_INTERVAL = 3600


# ── Auto-update ──────────────────────────────────────────────────

def _get_installed_version():
    """Return the currently installed version string."""
    try:
        from bingoviewer import __version__
        return __version__
    except Exception:
        return "0.0.0"


def _get_pypi_version():
    """Query PyPI for the latest version of bingoviewer. Returns None on failure."""
    try:
        import urllib.request
        url = "https://pypi.org/pypi/bingoviewer/json"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read())
            return data["info"]["version"]
    except Exception:
        return None


def _version_tuple(v):
    """Convert '1.3.0' to (1, 3, 0) for comparison."""
    try:
        return tuple(int(x) for x in v.split(".")[:3])
    except Exception:
        return (0, 0, 0)


def _should_check_update():
    """Return True if enough time has passed since the last check."""
    try:
        if _UPDATE_CHECK_FILE.exists():
            last = float(_UPDATE_CHECK_FILE.read_text().strip())
            return (time.time() - last) > _UPDATE_CHECK_INTERVAL
    except Exception:
        pass
    return True


def _record_update_check():
    """Record that we just checked for updates."""
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _UPDATE_CHECK_FILE.write_text(str(time.time()))
    except Exception:
        pass


def _do_upgrade():
    """Run pip install --upgrade bingoviewer. Returns True on success."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "bingoviewer", "-q"],
            capture_output=True, text=True, timeout=120,
        )
        return result.returncode == 0
    except Exception:
        return False


def check_and_update(force=False):
    """Check PyPI for a newer version and upgrade if found.

    Returns:
        None if no update needed/available
        new_version string if updated successfully
    """
    if not force and not _should_check_update():
        return None

    _record_update_check()

    installed = _get_installed_version()
    latest = _get_pypi_version()

    if latest is None:
        return None  # couldn't reach PyPI

    if _version_tuple(latest) <= _version_tuple(installed):
        return None  # already up to date

    print(f"  Updating BiNgo Genome Viewer: {installed} → {latest} ...")
    if _do_upgrade():
        print(f"  Updated to {latest}. Restarting...")
        return latest
    else:
        print(f"  Update failed (you can retry with: bingo --update)")
        return None


def _restart():
    """Re-exec the current process to pick up the new version."""
    os.execv(sys.executable, [sys.executable, "-m", "bingoviewer"] + sys.argv[1:])


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
    parser.add_argument("--update", action="store_true", help="Check for updates now")
    parser.add_argument("--no-update", action="store_true", help="Skip automatic update check")
    parser.add_argument("--version", action="store_true", help="Show version and exit")
    args = parser.parse_args()

    if args.version:
        print(f"BiNgo Genome Viewer {_get_installed_version()}")
        return 0

    if args.install:
        from bingoviewer.install_shortcut import main as install_main
        install_main()
        return 0

    # ── Auto-update check ────────────────────────────────────────
    if args.update:
        new_ver = check_and_update(force=True)
        if new_ver:
            _restart()
        else:
            print(f"  BiNgo Genome Viewer {_get_installed_version()} is up to date.")
            if args.update and not args.port and not args.host:
                return 0  # --update alone: just check and exit
    elif not args.no_update:
        # Background update check — only runs if enough time has passed
        new_ver = check_and_update(force=False)
        if new_ver:
            _restart()

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
    # On Windows, Python's default ProactorEventLoop has a known bug where
    # dropped browser connections cause noisy OSError tracebacks
    # (WinError 64: "The specified network name is no longer available").
    # Force the SelectorEventLoop which handles this gracefully.
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0
