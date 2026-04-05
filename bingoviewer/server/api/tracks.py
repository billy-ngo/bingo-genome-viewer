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
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from state import app_state

router = APIRouter(prefix="/api/tracks", tags=["tracks"])

_upload_dir = Path(tempfile.gettempdir()) / "genomics_viewer_uploads"
_upload_dir.mkdir(exist_ok=True)

_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _clean_name(raw: str) -> str:
    """Decode literal \\uXXXX escape sequences that some browsers embed in filenames."""
    return _UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), raw)


def _save_upload(file: UploadFile) -> Path:
    """Save an uploaded file to the shared upload directory."""
    dest = _upload_dir / _clean_name(file.filename)
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    return dest


@router.post("/load")
async def load_track(
    file: UploadFile = File(...),
    name: str = Form(""),
    index: Optional[UploadFile] = File(None),
):
    clean_filename = _clean_name(file.filename)
    dest = _upload_dir / clean_filename
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        # Save index file (.bai) alongside BAM with correct naming
        ext = dest.suffix.lower()
        if index is not None and ext in (".bam", ".cram"):
            # Always save as <bamname>.bam.bai so _find_index() can find it
            index_dest = dest.parent / (dest.name + ".bai")
            with index_dest.open("wb") as f:
                shutil.copyfileobj(index.file, f)
        elif index is not None:
            # Non-BAM index file — save with original name
            index_dest = _upload_dir / _clean_name(index.filename)
            with index_dest.open("wb") as f:
                shutil.copyfileobj(index.file, f)

        display_name = _clean_name(name) if name else clean_filename
        track = app_state.load_track(str(dest), display_name)
        compatibility = app_state.check_track_compatibility(track["id"])
        target_chromosomes = app_state.get_target_chromosomes(track["id"])

        # Suggest BigWig conversion for large text-based coverage files
        hint = None
        ext = dest.suffix.lower()
        if ext in (".wig", ".bedgraph", ".bdg"):
            size_mb = dest.stat().st_size / (1024 * 1024)
            if size_mb > 10:
                hint = (
                    f"Tip: This {size_mb:.0f} MB {ext} file may load slowly. "
                    f"Convert to BigWig with UCSC wigToBigWig for instant loading."
                )

        result = {**track, "compatibility": compatibility, "target_chromosomes": target_chromosomes}
        if hint:
            result["hint"] = hint
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))




@router.post("/load-path")
async def load_track_from_path(path: str = Form(...), name: str = Form("")):
    """Load track from a local file path (no upload needed)."""
    from pathlib import Path as P

    # If a .bai path is given, look for the matching .bam
    if path.lower().endswith('.bai'):
        bam_path = None
        if path.lower().endswith('.bam.bai'):
            bam_path = path[:-4]
        else:
            bam_path = str(P(path).with_suffix('.bam'))
        if bam_path and P(bam_path).resolve().exists():
            path = bam_path
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Index file detected. Matching BAM not found at '{bam_path}'. Load the .bam file instead."
            )

    p = P(path).resolve()
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if not p.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {path}")
    path = str(p)
    try:
        display_name = _clean_name(name) if name else p.name
        track = app_state.load_track(path, display_name)
        compatibility = app_state.check_track_compatibility(track["id"])
        target_chromosomes = app_state.get_target_chromosomes(track["id"])

        hint = None
        ext = p.suffix.lower()
        if ext in (".wig", ".bedgraph", ".bdg"):
            size_mb = p.stat().st_size / (1024 * 1024)
            if size_mb > 10:
                hint = (
                    f"Tip: This {size_mb:.0f} MB {ext} file may load slowly. "
                    f"Convert to BigWig with UCSC wigToBigWig for instant loading."
                )

        result = {**track, "compatibility": compatibility, "target_chromosomes": target_chromosomes}
        if hint:
            result["hint"] = hint
        return result
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
