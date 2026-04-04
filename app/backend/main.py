"""
BiNgo Genome Viewer — FastAPI application entry point.

Mounts the REST API routers (/api/genome, /api/tracks) and optionally
serves the built Vite frontend from frontend/dist/ for production use.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from api.genome import router as genome_router
from api.tracks import router as tracks_router
from api.data import router as data_router

app = FastAPI(title="BiNgo Genome Viewer API", version="1.0.0")

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

# Serve built frontend if present
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    def serve_index():
        return FileResponse(str(frontend_dist / "index.html"))


@app.get("/health")
def health():
    return {"status": "ok"}
