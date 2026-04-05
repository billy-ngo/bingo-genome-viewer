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
_VERSION_MARKER = _CONFIG_DIR / ".installed_version"

# Minimum seconds between automatic update checks (1 hour)
_UPDATE_CHECK_INTERVAL = 3600


def _show_welcome_if_new():
    """Show welcome message on first run or after upgrade."""
    ver = _get_installed_version()
    try:
        prev = _VERSION_MARKER.read_text().strip() if _VERSION_MARKER.exists() else None
    except Exception:
        prev = None

    if prev == ver:
        return

    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _VERSION_MARKER.write_text(ver)
    except Exception:
        pass

    is_upgrade = prev is not None
    print()
    print(f"  {'=' * 44}")
    if is_upgrade:
        print(f"    BiNgo Genome Viewer updated to v{ver}")
    else:
        print(f"    BiNgo Genome Viewer v{ver} installed")
    print(f"  {'=' * 44}")
    print()
    if not is_upgrade:
        print("  Supported formats:")
        print("    Genome:    .fasta .fa .gb .gbk .genbank")
        print("    Reads:     .bam (+ .bai index)")
        print("    Coverage:  .bw .bigwig .wig .bedgraph")
        print("    Variants:  .vcf .vcf.gz")
        print("    Features:  .bed .gtf .gff .gff3")
        print()
        print("  Quick start:")
        print("    - Load a genome file, then add tracks")
        print("    - Left-click drag to pan, scroll to zoom")
        print("    - Right-click drag to select a region")
        print("    - Double-click a gene to zoom in")
        print()
        print("  Commands:")
        print("    bingo              Launch the viewer")
        print("    bingo --update     Check for updates")
        print("    bingo --install    Create a desktop shortcut")
        print("    bingo --version    Show installed version")
        print()


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


def _log(msg):
    """Print to console if available, always log to file."""
    try:
        print(msg)
    except Exception:
        pass
    try:
        log = _CONFIG_DIR / "update.log"
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(log, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


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

    _log(f"  Updating BiNgo Genome Viewer: {installed} → {latest} ...")
    if _do_upgrade():
        _log(f"  Updated to {latest}. Restarting...")
        return latest
    else:
        _log(f"  Update failed (you can retry with: bingo --update)")
        return None


def _check_update_with_prompt():
    """Check for updates before launch. If an update is available, prompt the user.

    Works in both terminal mode (interactive prompt) and pythonw mode
    (shows a tkinter dialog if available, otherwise updates silently).
    """
    if not _should_check_update():
        return

    _record_update_check()

    installed = _get_installed_version()
    latest = _get_pypi_version()

    if latest is None or _version_tuple(latest) <= _version_tuple(installed):
        return

    # Determine if we have a terminal for interactive prompt
    has_terminal = sys.stdout is not None and hasattr(sys.stdout, 'write')
    try:
        if has_terminal:
            sys.stdout.write('')
        else:
            has_terminal = False
    except Exception:
        has_terminal = False

    should_update = False

    if has_terminal:
        try:
            print(f"\n  Update available: {installed} → {latest}")
            answer = input("  Install update now? [Y/n]: ").strip()
            should_update = answer.lower() != 'n'
        except (EOFError, OSError):
            # No stdin (e.g. pythonw) — try tkinter
            should_update = _tk_update_prompt(installed, latest)
    else:
        should_update = _tk_update_prompt(installed, latest)

    if should_update:
        _log(f"  Updating BiNgo Genome Viewer: {installed} → {latest} ...")
        if _do_upgrade():
            _log(f"  Updated to {latest}.")
            # Re-exec to pick up new version
            try:
                args = [a for a in sys.argv[1:] if a != '--update']
                os.execv(sys.executable, [sys.executable, "-m", "bingoviewer", "--no-update"] + args)
            except Exception:
                _log(f"  Restart failed. Please run 'bingo' again.")
        else:
            _log(f"  Update failed. You can retry with: bingo --update")


def _tk_update_prompt(installed, latest):
    """Show a tkinter yes/no dialog for update. Returns True to update."""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        answer = messagebox.askyesno(
            "BiNgo Genome Viewer Update",
            f"A new version is available: {installed} → {latest}\n\n"
            f"Install the update now?",
        )
        root.destroy()
        return answer
    except Exception:
        return False  # Can't prompt, skip update


def _restart():
    """Restart the process to pick up the new version.

    Uses subprocess + exit instead of os.execv for compatibility with
    pythonw.exe on Windows (which has no console for execv to inherit).
    """
    # Filter out --update to avoid infinite restart loops
    args = [a for a in sys.argv[1:] if a != "--update"]
    subprocess.Popen([sys.executable, "-m", "bingoviewer"] + args)
    sys.exit(0)


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

    # ── Manual update command ────────────────────────────────────
    if args.update:
        new_ver = check_and_update(force=True)
        if new_ver:
            print(f"  BiNgo Genome Viewer updated to {new_ver}.")
            print(f"  Run 'bingo' to launch the new version.")
        else:
            print(f"  BiNgo Genome Viewer {_get_installed_version()} is up to date.")
        return 0

    # ── Welcome message on first run / upgrade ─────────────────────
    _show_welcome_if_new()

    # ── Pre-launch update check (prompt user) ──────────────────────
    if not args.no_update:
        _check_update_with_prompt()

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
