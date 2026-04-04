"""
Tracks API — upload, list, and remove data tracks.

Endpoints:
  POST   /api/tracks/load       Upload a track file (BAM, BigWig, WIG, VCF, BED, GTF, GFF, GenBank)
  POST   /api/tracks/load-path  Re-open a track from an existing file path (session restore)
  GET    /api/tracks             List all loaded tracks
  DELETE /api/tracks/{track_id}  Remove a track
"""

import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from state import app_state

router = APIRouter(prefix="/api/tracks", tags=["tracks"])

_upload_dir = Path(tempfile.gettempdir()) / "genomics_viewer_uploads"
_upload_dir.mkdir(exist_ok=True)

_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _clean_name(raw: str) -> str:
    """Decode literal \\uXXXX escape sequences that some browsers embed in filenames."""
    return _UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), raw)


@router.post("/load")
async def load_track(file: UploadFile = File(...), name: str = Form("")):
    clean_filename = _clean_name(file.filename)
    dest = _upload_dir / clean_filename
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        display_name = _clean_name(name) if name else clean_filename
        track = app_state.load_track(str(dest), display_name)
        compatibility = app_state.check_track_compatibility(track["id"])
        target_chromosomes = app_state.get_target_chromosomes(track["id"])
        return {**track, "compatibility": compatibility, "target_chromosomes": target_chromosomes}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/load-path")
async def load_track_from_path(path: str = Form(...), name: str = Form("")):
    """Re-load track from an existing file path (for session restore)."""
    from pathlib import Path as P
    if not P(path).exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        display_name = _clean_name(name) if name else P(path).name
        track = app_state.load_track(path, display_name)
        target_chromosomes = app_state.get_target_chromosomes(track["id"])
        return {**track, "target_chromosomes": target_chromosomes}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
def list_tracks():
    return {"tracks": list(app_state.tracks.values())}


@router.delete("/{track_id}")
def remove_track(track_id: str):
    if track_id not in app_state.tracks:
        raise HTTPException(status_code=404, detail="Track not found")
    app_state.remove_track(track_id)
    return {"status": "removed"}
