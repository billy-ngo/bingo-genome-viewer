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
    basename in a folder of its own with a short unique name, so two
    same-named genome uploads don't overwrite each other, directory
    components are stripped, and the genome's name and messages keep the
    user's file name. The caller creates the folder."""
    base = Path(_clean_name(filename or "genome")).name
    if base in ("", ".", ".."):
        base = "genome"
    return _upload_dir / uuid.uuid4().hex[:8] / base


def _save_upload(file: UploadFile, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)


def _discard_upload(dest: Path, error: Exception) -> str:
    """Delete an upload that did not become part of the genome, with the
    index pyfaidx wrote beside it (best effort: on Windows a reader that
    failed may still hold it open). Returns ``error``'s message, naming the
    file instead of the upload's path."""
    if dest.parent.parent == _upload_dir:      # its own folder (_unique_dest)
        shutil.rmtree(dest.parent, ignore_errors=True)
    return str(error).replace(str(dest), dest.name)


@router.post("/load")
async def load_genome(file: UploadFile = File(...)):
    dest = _unique_dest(file.filename)
    loaded = False
    try:
        _save_upload(file, dest)
        app_state.load_genome(str(dest))
        loaded = True
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
        raise HTTPException(status_code=400, detail=str(e) if loaded else _discard_upload(dest, e))


def _track_pairings(snapshot: tuple) -> dict:
    """Each data track's target chromosomes after a merge, from where it was
    shown before (``snapshot``, AppState.merge_snapshot; see
    merged_target_chromosomes), and its compatibility against the genome as it
    is now, by track id. The targets are remembered as the track's new ones.
    A track whose load was finishing during the merge, given its targets
    since the snapshot but against the genome before the merge, is paired
    from them in the same way; given them against the merged genome, it is
    left out: its load answers with them."""
    old_names, per_track, given, version = snapshot
    out = {}

    def pair(track_id, targets):
        if track_id not in app_state.tracks:
            return
        try:
            pairing = {
                "target_chromosomes": targets(),
                "compatibility": app_state.check_track_compatibility(track_id),
            }
        except Exception:
            return            # the merge itself succeeded; leave this track as it was
        if track_id in app_state.tracks:          # not removed meanwhile
            app_state.remember_targets(track_id, pairing["target_chromosomes"])
            out[track_id] = pairing

    for track_id, (shown, mapped) in per_track.items():
        pair(track_id, lambda: app_state.merged_target_chromosomes(track_id, shown, old_names, mapped))
    for track_id, (shown, recorded) in app_state.remembered_targets().items():
        if track_id not in given and recorded == version:
            # Its ChromMap before the merge was not taken: drop none of shown.
            pair(track_id, lambda: app_state.merged_target_chromosomes(track_id, shown, old_names, None))
    return out


@router.post("/add-chromosomes")
async def add_chromosomes(file: UploadFile = File(...)):
    """Merge chromosomes from an additional genome file into the current genome.

    Besides the merged genome, the response carries ``tracks``: for every
    loaded data track, its ``target_chromosomes`` after the merge (where it
    was shown, plus the added chromosomes it pairs with by name or exact
    length; see AppState.merged_target_chromosomes) and its
    ``compatibility`` against the merged genome, so the client can show
    tracks on the added chromosomes they have data for and learn of a
    pairing the merge changed. Sequence names already in the genome stay with
    the file they came from; a file that adds none is refused (400)."""
    if app_state.genome is None:
        raise HTTPException(status_code=400, detail="No genome loaded")
    dest = _unique_dest(file.filename)
    merged = False
    try:
        _save_upload(file, dest)
        # In the worker pool, as the track load endpoints do: against a draft
        # assembly each track's pairing walks thousands of chromosomes.
        snapshot = await run_in_threadpool(app_state.merge_snapshot)
        # Merges under genome_lock (concurrent /sequence and /features requests
        # can't read mid-mutation) and invalidates the tracks' chromosome maps.
        app_state.add_chromosomes(str(dest))
        merged = True
        genome = app_state.genome
        tracks = await run_in_threadpool(_track_pairings, snapshot)
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
        raise HTTPException(status_code=400, detail=str(e) if merged else _discard_upload(dest, e))


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
