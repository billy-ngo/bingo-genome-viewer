"""
BiNgo Genome Viewer — FastAPI application entry point.

Mounts the REST API routers (/api/genome, /api/tracks) and serves
the bundled Vite frontend. Works both in pip-installed mode (frontend
bundled inside the package) and in development mode (frontend/dist/).

When launched via the CLI (BINGO_AUTO_SHUTDOWN=1), a background watchdog
shuts the server down automatically once all browser tabs have closed
(no heartbeat received for 30 seconds).
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

app = FastAPI(title="BiNgo Genome Viewer API", version="1.4.6")

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


# ── Auto-shutdown heartbeat system ─────────────────────────────
# The frontend sends GET /api/heartbeat every 10 seconds.
# If no heartbeat is received for _HEARTBEAT_TIMEOUT seconds after
# the first one, the server shuts itself down.  Only active when
# the BINGO_AUTO_SHUTDOWN environment variable is set (i.e. launched
# from the CLI / installer, not during development).

_last_heartbeat = 0.0
_HEARTBEAT_TIMEOUT = 30  # seconds


@app.get("/api/heartbeat")
def heartbeat():
    global _last_heartbeat
    _last_heartbeat = time.time()
    return {"status": "ok"}


def _auto_shutdown_watchdog():
    """Background thread: exit when all browser tabs are closed."""
    global _last_heartbeat
    while True:
        time.sleep(10)
        if _last_heartbeat > 0:
            elapsed = time.time() - _last_heartbeat
            if elapsed > _HEARTBEAT_TIMEOUT:
                # Clean up lock file before exiting
                lock_file = Path.home() / ".bingoviewer" / "server.lock"
                try:
                    lock_file.unlink(missing_ok=True)
                except Exception:
                    pass
                os._exit(0)


if os.environ.get("BINGO_AUTO_SHUTDOWN") == "1":
    _watchdog = threading.Thread(target=_auto_shutdown_watchdog, daemon=True)
    _watchdog.start()
