"""
Track data API — fetch coverage, reads, variants, and features for loaded tracks.

Endpoints:
  GET /api/tracks/{track_id}/coverage  Binned coverage signal
  GET /api/tracks/{track_id}/reads     Individual read alignments (zoomed-in only)
  GET /api/tracks/{track_id}/variants  Variant calls in a region
  GET /api/tracks/{track_id}/features  Annotation features in a region
"""

from fastapi import APIRouter, HTTPException, Query
from state import app_state

router = APIRouter(prefix="/api/tracks", tags=["data"])

READ_DETAIL_THRESHOLD = 50_000  # bp


@router.get("/{track_id}/coverage")
def get_coverage(track_id: str, chrom: str, start: int, end: int, bins: int = Query(default=1000, le=5000)):
    reader = _get_reader(track_id)
    track_type = app_state.tracks[track_id]["track_type"]

    if track_type not in ("coverage", "reads"):
        raise HTTPException(status_code=400, detail="Track does not support coverage")

    try:
        bins_data = reader.get_coverage(chrom, start, end, bins=bins)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Compute max of forward/positive values and min of reverse/negative values
    all_fwd = [b.get("forward", b["value"]) for b in bins_data]
    all_rev = [b.get("reverse", 0) for b in bins_data]
    all_vals = [b["value"] for b in bins_data]
    max_val = max(max(all_fwd, default=0), max(all_vals, default=0))
    min_val = min(min(all_rev, default=0), min(all_vals, default=0))
    return {
        "chrom": chrom, "start": start, "end": end,
        "bins": bins_data,
        "max_value": max_val,
        "min_value": min_val,
    }


@router.get("/{track_id}/reads")
def get_reads(track_id: str, chrom: str, start: int, end: int):
    reader = _get_reader(track_id)
    if app_state.tracks[track_id]["track_type"] != "reads":
        raise HTTPException(status_code=400, detail="Track does not support read-level data")

    region_len = end - start
    if region_len > READ_DETAIL_THRESHOLD:
        raise HTTPException(
            status_code=400,
            detail=f"Region too wide for read view (max {READ_DETAIL_THRESHOLD:,} bp). Zoom in or use coverage endpoint."
        )

    try:
        reads = reader.get_reads(chrom, start, end)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"chrom": chrom, "start": start, "end": end, "reads": reads, "total": len(reads)}


@router.get("/{track_id}/variants")
def get_variants(track_id: str, chrom: str, start: int, end: int):
    reader = _get_reader(track_id)
    if app_state.tracks[track_id]["track_type"] != "variants":
        raise HTTPException(status_code=400, detail="Track does not support variants")

    try:
        variants = reader.get_variants(chrom, start, end)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"chrom": chrom, "start": start, "end": end, "variants": variants}


@router.get("/{track_id}/features")
def get_features(track_id: str, chrom: str, start: int, end: int):
    if track_id not in app_state.tracks:
        raise HTTPException(status_code=404, detail="Track not found")
    track_type = app_state.tracks[track_id]["track_type"]

    if track_type not in ("annotations", "genome_annotations"):
        raise HTTPException(status_code=400, detail="Track does not support features")

    try:
        if track_type == "genome_annotations":
            if app_state.genome is None:
                raise HTTPException(status_code=404, detail="No genome loaded")
            features = app_state.genome.get_features(chrom, start, end)
        else:
            reader = _get_reader(track_id)
            features = reader.get_features(chrom, start, end)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"chrom": chrom, "start": start, "end": end, "features": features}


def _get_reader(track_id: str):
    if track_id not in app_state.tracks:
        raise HTTPException(status_code=404, detail="Track not found")
    reader = app_state.readers.get(track_id)
    if reader is None:
        raise HTTPException(status_code=404, detail="Reader not initialised for track")
    return reader
