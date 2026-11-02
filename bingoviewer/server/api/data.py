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


def _validate_region(start: int, end: int):
    """Validate region coordinates. Raises HTTPException on invalid input."""
    if start < 0:
        raise HTTPException(status_code=400, detail="start must be >= 0")
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be > start")


def _superseded():
    """Response for a request overtaken by a newer one for the same track
    (the client already aborted it). 409, which the client may retry."""
    return HTTPException(status_code=409, detail="Superseded by a newer request for this track")


@router.get("/{track_id}/coverage")
def get_coverage(track_id: str, chrom: str, start: int, end: int, bins: int = Query(default=1000, ge=1, le=10000)):
    _validate_region(start, end)
    reader = _get_reader(track_id)
    track_type = app_state.tracks[track_id]["track_type"]

    if track_type not in ("coverage", "reads"):
        raise HTTPException(status_code=400, detail="Track does not support coverage")

    # Per-track lock: bamnostic/pyBigWig file handles are not thread-safe.
    # Concurrent reads on the same reader can corrupt seek state and raise
    # spurious errors under rapid zoom/pan. Serialize within a single track;
    # other tracks remain free to fetch in parallel. Registering the request
    # first lets an in-flight read scan on this track notice it is stale, and
    # a queued request give up (freeing its worker thread) once overtaken.
    gen = app_state.next_request(track_id)
    track_chrom = app_state.resolve_track_chrom(track_id, chrom)
    try:
        with app_state.lock_if_current(track_id, gen) as current:
            if not current:
                raise _superseded()
            res = reader.get_coverage(track_chrom, start, end, bins=bins)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    # Readers return a list of bins, or {"bins": [...], "meta": {...}} when
    # they have more to say (BAM coverage index progress, truncation).
    if isinstance(res, dict):
        bins_data, meta = res.get("bins", []), res.get("meta", {})
    else:
        bins_data, meta = res, {}

    # Each bin carries its bp-weighted mean ("value", plus "forward"/"reverse"
    # for strand data) and the extremes of the underlying signal ("max" = the
    # largest positive-side value, "min" = the smallest negative-side value).
    # max_value/min_value describe the means (backwards compatible);
    # peak_max/peak_min the true extremes — what a peak-preserving axis needs.
    # Bins not computed yet ("pending") are excluded from both.
    done = [b for b in bins_data if not b.get("pending")]
    all_fwd = [b.get("forward", b["value"]) for b in done]
    all_rev = [b.get("reverse", 0) for b in done]
    all_vals = [b["value"] for b in done]
    max_val = max(max(all_fwd, default=0), max(all_vals, default=0))
    min_val = min(min(all_rev, default=0), min(all_vals, default=0))
    peak_max = max((b.get("max", b.get("forward", b["value"])) for b in done), default=0)
    peak_min = min((b.get("min", min(b.get("reverse", 0), b["value"])) for b in done), default=0)
    pending = len(done) != len(bins_data)
    out = {
        "chrom": chrom, "start": start, "end": end,
        "bins": bins_data,
        "bin_size": (end - start) / len(bins_data) if bins_data else None,
        "max_value": max_val,
        "min_value": min_val,
        "peak_max": peak_max,
        "peak_min": peak_min,
        # False while a background index is still filling in pending bins
        # (asking again later returns more data).
        "complete": not (pending and meta.get("coverage_state") == "building"),
        **meta,
    }
    # Whole-chromosome sign: lets the client choose the split (forward up /
    # reverse down) layout once per chromosome rather than per fetched window.
    has_negative = getattr(reader, "has_negative", None)
    if callable(has_negative):
        hn = has_negative(track_chrom)
        if hn is not None:
            out["has_negative"] = bool(hn)
    return out


@router.get("/{track_id}/stats")
def get_stats(track_id: str, chrom: str, start: int, end: int):
    """Exact statistics of a coverage/read track's signal over [start, end):
    mean per covered bp, max, min, per-base sum and covered bp — plus
    forward/reverse sums for strand data. Unlike summing displayed bins, the
    result does not depend on the zoom level the track is shown at."""
    _validate_region(start, end)
    reader = _get_reader(track_id)
    if app_state.tracks[track_id]["track_type"] not in ("coverage", "reads"):
        raise HTTPException(status_code=400, detail="Track does not support signal statistics")
    track_chrom = app_state.resolve_track_chrom(track_id, chrom)
    try:
        with app_state.track_lock(track_id):
            res = reader.get_coverage(track_chrom, start, end, bins=1)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    bins_data = res.get("bins", []) if isinstance(res, dict) else res
    out = {"chrom": chrom, "start": start, "end": end, "covered_bp": 0,
           "mean": 0.0, "max": 0.0, "min": 0.0, "sum": 0.0, "complete": True}
    if not bins_data:
        return out
    b = bins_data[0]
    if b.get("pending"):
        out["complete"] = False
        return out
    cov = b.get("cov", b["end"] - b["start"])
    out.update(covered_bp=cov, mean=b["value"], max=b.get("max", b["value"]),
               min=b.get("min", b["value"]), sum=b["value"] * cov)
    if "forward" in b:
        out["forward_sum"] = b["forward"] * cov
        out["reverse_sum"] = b["reverse"] * cov
    return out


@router.get("/{track_id}/reads")
def get_reads(track_id: str, chrom: str, start: int, end: int):
    _validate_region(start, end)
    reader = _get_reader(track_id)
    if app_state.tracks[track_id]["track_type"] != "reads":
        raise HTTPException(status_code=400, detail="Track does not support read-level data")

    region_len = end - start
    if region_len > READ_DETAIL_THRESHOLD:
        raise HTTPException(
            status_code=400,
            detail=f"Region too wide for read view (max {READ_DETAIL_THRESHOLD:,} bp). Zoom in or use coverage endpoint."
        )

    gen = app_state.next_request(track_id)
    track_chrom = app_state.resolve_track_chrom(track_id, chrom)
    try:
        with app_state.lock_if_current(track_id, gen) as current:
            if not current:
                raise _superseded()
            res = reader.get_reads(track_chrom, start, end,
                                   is_current=lambda: app_state.is_current(track_id, gen))
    except HTTPException:
        raise
    except Exception as e:
        # 503 (rather than 500) signals the frontend that this is transient
        # and worth retrying — common under rapid zoom/pan.
        raise HTTPException(status_code=503, detail=str(e))
    if isinstance(res, dict):
        reads = res.get("reads", [])
        truncated = bool(res.get("truncated"))
        total = res.get("total", len(reads))
        total_exact = bool(res.get("total_exact", True))
    else:
        reads, truncated, total, total_exact = res, False, len(res), True

    # "total" counts every read overlapping the window; "reads" may be a
    # uniform sample of them (truncated=True).
    return {"chrom": chrom, "start": start, "end": end, "reads": reads,
            "total": total, "total_exact": total_exact, "truncated": truncated}


@router.get("/{track_id}/variants")
def get_variants(track_id: str, chrom: str, start: int, end: int):
    _validate_region(start, end)
    reader = _get_reader(track_id)
    if app_state.tracks[track_id]["track_type"] != "variants":
        raise HTTPException(status_code=400, detail="Track does not support variants")

    try:
        with app_state.track_lock(track_id):
            variants = reader.get_variants(app_state.resolve_track_chrom(track_id, chrom), start, end)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    return {"chrom": chrom, "start": start, "end": end, "variants": variants}


@router.get("/{track_id}/features")
def get_features(track_id: str, chrom: str, start: int, end: int):
    _validate_region(start, end)
    if track_id not in app_state.tracks:
        raise HTTPException(status_code=404, detail="Track not found")
    track_type = app_state.tracks[track_id]["track_type"]

    if track_type not in ("annotations", "genome_annotations"):
        raise HTTPException(status_code=400, detail="Track does not support features")

    try:
        if track_type == "genome_annotations":
            if app_state.genome is None:
                raise HTTPException(status_code=404, detail="No genome loaded")
            with app_state.genome_lock:
                features = app_state.genome.get_features(chrom, start, end)
        else:
            reader = _get_reader(track_id)
            with app_state.track_lock(track_id):
                features = reader.get_features(chrom, start, end)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    return {"chrom": chrom, "start": start, "end": end, "features": features}


def _get_reader(track_id: str):
    if track_id not in app_state.tracks:
        raise HTTPException(status_code=404, detail="Track not found")
    reader = app_state.readers.get(track_id)
    if reader is None:
        raise HTTPException(status_code=404, detail="Reader not initialised for track")
    return reader
