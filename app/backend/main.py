"""
BiNgo Genome Viewer — FastAPI application entry point.

Mounts the REST API routers (/api/genome, /api/tracks, /api/tracks/{id}/...)
and serves the bundled Vite frontend. Works in both pip-installed mode
(frontend bundled inside the package) and development mode
(``frontend/dist/``).

Auto-shutdown
-------------
When launched via the CLI (``BINGO_AUTO_SHUTDOWN=1``), a background
watchdog terminates the server soon after the user closes the last
browser tab. The previous single-timestamp approach had several gaps:

* No proactive close detection — closing a tab took the full 30 s
  timeout to register.
* Background-tab timer throttling (Chrome reduces ``setInterval`` to
  ~1 / minute after 5 min of being hidden) could trigger a false
  shutdown while the user still had the viewer open.
* If the frontend never loaded at all (e.g., the user dismissed the
  browser launch), the server lived forever — the watchdog short-
  circuited on the initial-zero timestamp.
* A page reload briefly drops the active tab to zero between
  ``pagehide`` and the new page's first heartbeat; the old logic could
  race that gap and exit.

This implementation tracks tabs individually (each tab generates a
UUID and sends it with every heartbeat) and supports two notifications:

* Periodic ``GET  /api/heartbeat?tab=<uuid>``  — keep-alive.
* One-shot ``POST /api/tab-closing?tab=<uuid>`` — sent via
  ``navigator.sendBeacon`` on ``pagehide`` / ``beforeunload`` so the
  server can drop the tab from its active set immediately.

The watchdog exits when *all* of the following hold:

* No tab has heartbeated within ``_HEARTBEAT_TIMEOUT`` seconds
  (90 s — covers throttled hidden tabs).
* The "no active tabs" condition has held for at least
  ``_CLOSE_GRACE`` seconds (15 s — absorbs the reload gap).
* If the frontend has *never* connected, exits after
  ``_STARTUP_GRACE`` seconds (60 s).
"""

import os
import time
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.genome import router as genome_router
from api.tracks import router as tracks_router
from api.data import router as data_router

app = FastAPI(title="BiNgo Genome Viewer API", version="2.9.5")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(genome_router)
app.include_router(tracks_router)
app.include_router(data_router)

# Locate the built frontend — check bundled package location first, then dev layout
_pkg_dist = Path(__file__).parent.parent / "frontend_dist"      # pip-installed
_dev_dist = Path(__file__).parent.parent / "frontend" / "dist"  # dev / launcher mode
frontend_dist = _pkg_dist if _pkg_dist.exists() else (_dev_dist if _dev_dist.exists() else None)

if frontend_dist:
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    def serve_index():
        return FileResponse(str(frontend_dist / "index.html"))


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Auto-shutdown heartbeat system ─────────────────────────────────
# See module docstring for the design rationale.

_HEARTBEAT_TIMEOUT = 90      # seconds: drop a tab if no heartbeat in this long
_STARTUP_GRACE = 60          # seconds: exit if no tab ever connected
_CLOSE_GRACE = 15            # seconds: hold-off after active==0 before exiting
_WATCHDOG_TICK = 5           # seconds: how often the watchdog re-checks state

_tab_state: dict[str, float] = {}   # tab_id -> last_seen wall-clock time
_tab_lock = threading.Lock()
_ever_seen_tab = False
_server_started_at = time.time()


def _record_tab(tab_id: str | None) -> None:
    """Mark a tab as alive (called by /api/heartbeat)."""
    global _ever_seen_tab
    key = tab_id or "_default"
    with _tab_lock:
        _tab_state[key] = time.time()
        _ever_seen_tab = True


def _drop_tab(tab_id: str | None) -> None:
    """Remove a tab from the active set (called by /api/tab-closing)."""
    key = tab_id or "_default"
    with _tab_lock:
        _tab_state.pop(key, None)


@app.get("/api/heartbeat")
def heartbeat(tab: str = ""):
    """Keep-alive ping from a browser tab."""
    _record_tab(tab)
    return {"status": "ok"}


@app.post("/api/tab-closing")
def tab_closing(tab: str = ""):
    """Sent by the frontend on pagehide/beforeunload via sendBeacon so
    the server can drop the tab immediately rather than waiting for the
    heartbeat timeout. Returns 204 because the browser may have already
    started discarding the response by the time it arrives."""
    _drop_tab(tab)
    return {"status": "ok"}


def _exit_now() -> None:
    """Clean up the lock file and terminate. ``os._exit`` skips uvicorn's
    graceful-shutdown path — that's intentional, the user has closed
    every tab and we don't want to wait for in-flight connections.

    If the CLI was started with ``--close-window`` the parent shell PID
    is in ``BINGO_PARENT_PID``; we terminate it here so the user's
    minimised cmd window vanishes when the browser closes. Guarded by
    parent-process-name check so we never kill an IDE, SSH session, or
    anything that isn't a known Windows shell."""
    try:
        (Path.home() / ".bingoviewer" / "server.lock").unlink(missing_ok=True)
    except Exception:
        pass
    if os.environ.get("BINGO_CLOSE_WINDOW") == "1":
        _terminate_parent_shell_if_safe()
    os._exit(0)


_SAFE_PARENT_SHELL_NAMES = {"cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe"}


def _terminate_parent_shell_if_safe() -> None:
    """Windows-only: close the launching terminal window iff it's a
    recognised shell. No-op on macOS / Linux, no-op when launched without
    a console (pythonw, service), no-op when the parent is anything other
    than cmd / PowerShell."""
    import sys
    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        if not kernel32.GetConsoleWindow():
            return
        try:
            pid = int(os.environ.get("BINGO_PARENT_PID", "") or os.getppid())
        except (TypeError, ValueError):
            return
        # Identify the parent — only kill known shells
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(len(buf))
            ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
            parent_name = Path(buf.value).name.lower() if ok else None
        finally:
            kernel32.CloseHandle(h)
        if parent_name not in _SAFE_PARENT_SHELL_NAMES:
            return
        # Open with TERMINATE rights and kill
        PROCESS_TERMINATE = 0x0001
        h = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not h:
            return
        try:
            kernel32.TerminateProcess(h, 0)
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        pass


def _auto_shutdown_watchdog():
    """Background thread that exits the server when no tab has been
    alive recently. See module docstring for the full state machine."""
    last_empty_at: float | None = None
    while True:
        time.sleep(_WATCHDOG_TICK)
        now = time.time()

        # Expire stale tabs (heartbeat older than HEARTBEAT_TIMEOUT)
        with _tab_lock:
            stale = [t for t, ts in _tab_state.items() if now - ts > _HEARTBEAT_TIMEOUT]
            for t in stale:
                _tab_state.pop(t, None)
            active = len(_tab_state)

        if active > 0:
            last_empty_at = None
            continue

        # No active tabs right now.
        if last_empty_at is None:
            last_empty_at = now

        if not _ever_seen_tab:
            # Frontend never connected (user dismissed the browser launch,
            # backend was started without a UI, etc.). Wait for STARTUP_GRACE
            # before assuming nobody will show up.
            if (now - _server_started_at) > _STARTUP_GRACE:
                _exit_now()
            continue

        # We did see tabs at some point and they're all gone now. Wait a
        # short close grace to absorb page reloads (pagehide → new page
        # load briefly leaves us with zero active tabs).
        if (now - last_empty_at) > _CLOSE_GRACE:
            _exit_now()


if os.environ.get("BINGO_AUTO_SHUTDOWN") == "1":
    _watchdog = threading.Thread(target=_auto_shutdown_watchdog, daemon=True)
    _watchdog.start()
