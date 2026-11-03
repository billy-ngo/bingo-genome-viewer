"""
Genome API — upload and query reference genomes (FASTA, GenBank).

Endpoints:
  POST /api/genome/load        Upload a genome file
  POST /api/genome/add-chromosomes  Merge another genome file's chromosomes into the loaded genome
  POST /api/genome/load-path   Re-open a genome from an existing file path (session restore)
  GET  /api/genome/chromosomes List loaded chromosomes
  GET  /api/genome/sequence    Fetch a subsequence by region
"""

import re
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from starlette.concurrency import run_in_threadpool
from state import app_state

router = APIRouter(prefix="/api/genome", tags=["genome"])

_upload_dir = Path(tempfile.gettempdir()) / "genomics_viewer_uploads"
_upload_dir.mkdir(exist_ok=True)

_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _clean_name(raw: str) -> str:
    return _UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), raw)


def _unique_dest(filename: str) -> Path:
    """A collision-proof, path-safe destination in the upload dir: the cleaned
    basename prefixed with a short unique token, so two same-named genome
    uploads don't overwrite each other and directory components are stripped."""
    base = Path(_clean_name(filename or "genome")).name or "genome"
    return _upload_dir / f"{uuid.uuid4().hex[:8]}_{base}"


@router.post("/load")
async def load_genome(file: UploadFile = File(...)):
    dest = _unique_dest(file.filename)
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
            "annotated_chromosomes": genome.annotated_chromosomes,
            "feature_types": genome.feature_types,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _track_pairings() -> dict:
    """Each loaded data track's target chromosomes and compatibility against
    the genome as it is now, by track id."""
    out = {}
    for track_id in list(app_state.tracks):
        if track_id == "genome_annotations":
            continue
        try:
            pairing = {
                "target_chromosomes": app_state.get_target_chromosomes(track_id),
                "compatibility": app_state.check_track_compatibility(track_id),
            }
        except Exception:
            continue          # the merge itself succeeded; leave this track as it was
        if track_id in app_state.tracks:          # not removed meanwhile
            out[track_id] = pairing
    return out


@router.post("/add-chromosomes")
async def add_chromosomes(file: UploadFile = File(...)):
    """Merge chromosomes from an additional genome file into the current genome.

    Besides the merged genome, the response carries ``tracks``: for every
    loaded data track, its ``target_chromosomes`` and ``compatibility``
    against the merged genome (as /api/tracks/load returns them), so the
    client can show tracks on the added chromosomes they have data for and
    learn of a pairing the merge changed."""
    if app_state.genome is None:
        raise HTTPException(status_code=400, detail="No genome loaded")
    dest = _unique_dest(file.filename)
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        # Merges under genome_lock (concurrent /sequence and /features requests
        # can't read mid-mutation) and invalidates the tracks' chromosome maps.
        app_state.add_chromosomes(str(dest))
        genome = app_state.genome
        # In the worker pool, as the track load endpoints do: against a draft
        # assembly each track's check walks thousands of chromosomes.
        tracks = await run_in_threadpool(_track_pairings)
        return {
            "name": genome.name,
            "file_path": genome.file_path,
            "chromosomes": genome.chromosomes,
            "is_annotated": genome.is_annotated(),
            "annotated_chromosomes": genome.annotated_chromosomes,
            "feature_types": genome.feature_types,
            "tracks": tracks,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/load-path")
async def load_genome_from_path(path: str = Form(...)):
    """Load genome from a local file path."""
    from pathlib import Path as P
    path = path.strip()
    for q in ('"', "'", '`'):
        path = path.strip(q)
    path = path.strip().replace('\\ ', ' ')
    p = P(path).expanduser()
    if not p.exists() and not p.resolve().exists():
        parent = p.parent
        if parent.exists():
            detail = f"File not found: {p.name} in {parent}. Check the filename for typos."
        else:
            broken = p
            while not broken.parent.exists() and broken.parent != broken:
                broken = broken.parent
            detail = f"Directory not found: {broken.parent}. Check the path for typos."
        raise HTTPException(status_code=404, detail=detail)
    resolved = p.resolve()
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {path}")
    # Verify file is readable (catches cloud-synced "online only" files)
    try:
        with open(str(resolved), 'rb') as f:
            f.read(1)
    except PermissionError:
        raise HTTPException(status_code=400, detail=f"Cannot read file: {resolved.name}. If this is a cloud-synced file (OneDrive, Dropbox), make sure it is downloaded locally (not 'online only').")
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Cannot read file: {resolved.name}. {e}")
    try:
        app_state.load_genome(str(resolved))
        genome = app_state.genome
        return {
            "name": genome.name,
            "file_path": str(resolved),
            "chromosomes": genome.chromosomes,
            "is_annotated": genome.is_annotated(),
            "annotated_chromosomes": genome.annotated_chromosomes,
            "feature_types": genome.feature_types,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/chromosomes")
def get_chromosomes():
    if app_state.genome is None:
        raise HTTPException(status_code=404, detail="No genome loaded")
    return {"chromosomes": app_state.genome.chromosomes}


@router.get("/search")
def search_features(q: str = "", limit: int = 30):
    """Search the genome's annotations and all loaded annotation/peak tracks
    for a gene/feature by name, gene, locus_tag, or product."""
    q = (q or "").strip()
    if len(q) < 1:
        return {"query": q, "results": []}
    try:
        results = app_state.search(q, limit=max(1, min(limit, 100)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"query": q, "results": results}


@router.get("/sequence")
def get_sequence(chrom: str, start: int, end: int):
    if app_state.genome is None:
        raise HTTPException(status_code=404, detail="No genome loaded")
    if end - start > 1_000_000:
        raise HTTPException(status_code=400, detail="Requested region too large (max 1 Mbp)")
    try:
        # pyfaidx is not thread-safe; serialize concurrent reads from
        # multiple tracks (e.g. AnnotationTrack + ReadTrack reference fetch)
        with app_state.genome_lock:
            seq = app_state.genome.get_sequence(chrom, start, end)
        return {"chrom": chrom, "start": start, "end": end, "sequence": seq}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        # Transient → 503 so the frontend retries
        raise HTTPException(status_code=503, detail=str(e))
