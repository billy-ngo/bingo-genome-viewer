"""
Genome API — upload and query reference genomes (FASTA, GenBank).

Endpoints:
  POST /api/genome/load        Upload a genome file
  POST /api/genome/load-path   Re-open a genome from an existing file path (session restore)
  GET  /api/genome/chromosomes List loaded chromosomes
  GET  /api/genome/sequence    Fetch a subsequence by region
"""

import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from state import app_state

router = APIRouter(prefix="/api/genome", tags=["genome"])

_upload_dir = Path(tempfile.gettempdir()) / "genomics_viewer_uploads"
_upload_dir.mkdir(exist_ok=True)

_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _clean_name(raw: str) -> str:
    return _UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), raw)


@router.post("/load")
async def load_genome(file: UploadFile = File(...)):
    dest = _upload_dir / _clean_name(file.filename)
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        app_state.load_genome(str(dest))
        genome = app_state.genome
        return {
            "name": genome.name,
            "file_path": str(dest),
            "chromosomes": genome.chromosomes,
            "is_annotated": genome.is_annotated(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/load-path")
async def load_genome_from_path(path: str = Form(...)):
    """Re-load genome from an existing file path (for session restore)."""
    from pathlib import Path as P
    if not P(path).exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        app_state.load_genome(path)
        genome = app_state.genome
        return {
            "name": genome.name,
            "file_path": path,
            "chromosomes": genome.chromosomes,
            "is_annotated": genome.is_annotated(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/chromosomes")
def get_chromosomes():
    if app_state.genome is None:
        raise HTTPException(status_code=404, detail="No genome loaded")
    return {"chromosomes": app_state.genome.chromosomes}


@router.get("/sequence")
def get_sequence(chrom: str, start: int, end: int):
    if app_state.genome is None:
        raise HTTPException(status_code=404, detail="No genome loaded")
    if end - start > 1_000_000:
        raise HTTPException(status_code=400, detail="Requested region too large (max 1 Mbp)")
    try:
        seq = app_state.genome.get_sequence(chrom, start, end)
        return {"chrom": chrom, "start": start, "end": end, "sequence": seq}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
