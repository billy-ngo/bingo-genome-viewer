"""
BAM reader — uses bamnostic (pure Python, Windows-compatible).
Requires a .bai index alongside the BAM file for random-access queries.
CRAM and SAM are not supported by bamnostic; convert to an indexed BAM.

Coverage comes from a BamCoverageIndex (exact per-base depth, built once in
the background); individual reads for the zoomed-in view come from bamnostic.
"""

from pathlib import Path
from typing import Optional

import bamnostic as bam

from readers.bam_coverage import BamCoverageIndex, SKIP_FLAGS

MAX_READS_RETURNED = 5000
MAX_READS_SCANNED = 400_000    # bound on reads examined for one read-view request
MAX_COVERAGE_READS = 500_000   # cap for the live fallback pileup (index unavailable)
READ_DETAIL_THRESHOLD = 50_000  # bp
# Reads hidden in the pileup, matching IGV's defaults and the coverage index.
READ_VIEW_SKIP_FLAGS = 0x200 | 0x400   # QC-fail | duplicate
# bamnostic's fetch() decides overlap from pos + len(SEQ) instead of the
# reference span, so it drops reads that start left of the window and span
# more reference than their sequence length (long reads with deletions,
# alignments stored without SEQ). We fetch from further left and re-check
# overlap with the true CIGAR span; until the coverage index reports the
# longest read on a contig, this lookback is used.
DEFAULT_READ_LOOKBACK = 2_000

# Standard index naming conventions: file.bam.bai and file.bai
_INDEX_SUFFIXES = (".bam.bai", ".bai")

# A valid .bai begins with the 4-byte magic "BAI\1" and a non-trivial body.
_BAI_MAGIC = b"BAI\x01"
_MIN_BAI_SIZE = 8  # magic (4) + n_ref (4) at the very least


def _valid_bai(path: Path) -> bool:
    """Return True only if `path` looks like a real, non-empty .bai index.

    Catches the empty/zero-byte and wrong-format cases that would otherwise
    surface as a cryptic ``struct.error: unpack requires a buffer of 8 bytes``
    or ``AssertionError: Wrong BAI magic header`` from deep inside bamnostic.
    """
    try:
        if path.stat().st_size < _MIN_BAI_SIZE:
            return False
        with path.open("rb") as f:
            return f.read(4) == _BAI_MAGIC
    except OSError:
        return False


def _find_index(bam_path: str, index_path: Optional[str] = None) -> Optional[str]:
    """Locate a usable .bai index for the given BAM file.

    If ``index_path`` is supplied (e.g. the user pointed at a .bai that lives
    in a different directory), it takes precedence when it exists and is a
    valid index. Otherwise both standard naming conventions (file.bam.bai and
    file.bai) are checked in the BAM's own directory. Only indexes that pass
    the magic/size sanity check are returned.
    """
    if index_path:
        ip = Path(index_path).expanduser()
        if ip.exists() and _valid_bai(ip):
            return str(ip.resolve())
        # An explicit-but-bad index path is a hard error so the user learns
        # their index is empty/corrupt rather than silently falling back.
        if ip.exists():
            raise ValueError(
                f"The supplied index '{ip.name}' is not a valid .bai file "
                f"(empty or wrong format). Rebuild it with: samtools index <file>.bam"
            )

    p = Path(bam_path)
    for candidate in (
        p.parent / (p.name + ".bai"),   # reads.bam.bai
        p.with_suffix(".bai"),           # reads.bai
    ):
        if candidate.exists() and _valid_bai(candidate):
            return str(candidate)
    return None


def _fetch_error_msg(file_path: str) -> str:
    return (
        f"Failed reading alignments from '{Path(file_path).name}' — the BAM or "
        f"its index appears to be corrupt or truncated. Re-create it with "
        f"samtools (samtools sort, then samtools index)."
    )


def _parse_cigar(cigar_string: str) -> list[tuple[int, str]]:
    """Parse a CIGAR string into a list of (length, op) tuples."""
    ops = []
    num = ""
    for ch in cigar_string:
        if ch.isdigit():
            num += ch
        else:
            if num:
                ops.append((int(num), ch))
            num = ""
    return ops


def _norm_chrom(name: str) -> str:
    """Normalise a contig name for comparison: strip a *leading* 'chr' prefix
    only (not internal occurrences) and lowercase. So 'chr1'/'1' match but
    'achrb' is not mangled to 'ab'."""
    n = name[3:] if name[:3].lower() == "chr" else name
    return n.lower()


class BamReader:
    def __init__(self, file_path: str, index_path: Optional[str] = None):
        self.file_path = file_path

        # Validate BAM file exists
        if not Path(file_path).exists():
            raise FileNotFoundError(f"BAM file not found: {file_path}")

        # Resolve (and validate) the index before opening.
        resolved_index = _find_index(file_path, index_path)
        if resolved_index is None:
            bam_name = Path(file_path).name
            raise FileNotFoundError(
                f"BAM index (.bai) not found for '{bam_name}'. "
                f"A BAM must be sorted and indexed. Create one with: "
                f"samtools index '{bam_name}'  "
                f"(expected '{bam_name}.bai' or '{Path(bam_name).stem}.bai' "
                f"beside the BAM, or supply its path explicitly)."
            )

        # Open tolerantly (ignore a missing EOF marker — common for BAMs
        # copied/streamed without the trailing block) and convert any
        # low-level decode failure into an actionable message instead of a
        # raw 'Malformed BGZF block' / 'Wrong BAI magic header' traceback.
        try:
            self._aln = bam.AlignmentFile(
                file_path, "rb",
                index_filename=resolved_index,
                ignore_truncation=True,
            )
        except Exception as e:
            msg = str(e).lower()
            if "bai" in msg or "index" in msg or "magic" in msg:
                raise ValueError(
                    f"The BAM index for '{Path(file_path).name}' is corrupt or "
                    f"incompatible. Rebuild it with: samtools index "
                    f"'{Path(file_path).name}'"
                ) from e
            raise ValueError(
                f"'{Path(file_path).name}' could not be read as a BAM file — it "
                f"may be corrupt, truncated, or not a BAM. Re-create it with "
                f"samtools (sort, then index)."
            ) from e

        # A BAM with no reference sequences can't be queried meaningfully.
        if not self.chromosomes:
            raise ValueError(
                f"'{Path(file_path).name}' has no reference sequences in its "
                f"header — it cannot be displayed. Ensure the BAM was aligned "
                f"to a reference and retains its @SQ header."
            )

        # Exact coverage is built in the background from a separate file handle
        # (bamnostic's handle stays free for read queries).
        self._cov = BamCoverageIndex(file_path)

    def close(self):
        self._cov.cancel()
        try:
            self._aln.close()
        except Exception:
            pass

    def coverage_status(self) -> dict:
        return self._cov.status()

    def has_negative(self, chrom: str) -> bool:
        return False   # read depth is never negative

    def _contig_length(self, chrom: str) -> int:
        for c in self.chromosomes:
            if c["name"] == chrom:
                return c["length"]
        return 0

    @property
    def chromosomes(self) -> list[dict]:
        """Reference contigs as [{name, length}].

        The BAM header is immutable once opened, so the contig list is computed
        once and cached — it is read on every ``_resolve_chrom`` (i.e. every
        coverage/read fetch), and rebuilding it per request was wasted work on
        many-contig BAMs.
        """
        cached = getattr(self, "_chrom_cache", None)
        if cached is not None:
            return cached
        result = self._read_chromosomes()
        self._chrom_cache = result
        return result

    def _read_chromosomes(self) -> list[dict]:
        """Compute the contig list from bamnostic's authoritative binary
        reference block via the pysam-compatible ``references``/``lengths``
        tuples (always present, regardless of whether the BAM carries an @SQ SAM
        *text* header). The previous implementation used ``header.get('SQ')``
        which raises ``AttributeError`` on bamnostic's ``BAMheader`` object (it
        is not a dict) — i.e. it broke for *every* BAM. Falls back to the raw
        refs map, then to a dict-style header, for resilience across versions.
        """
        aln = self._aln
        refs = getattr(aln, "references", None)
        lengths = getattr(aln, "lengths", None)
        if refs and lengths and len(refs) == len(lengths):
            return [{"name": n, "length": int(l)} for n, l in zip(refs, lengths)]

        # Fallback 1: bamnostic's binary header refs map {tid: (name, length)}
        header = getattr(aln, "header", None)
        refs_map = getattr(header, "refs", None)
        if isinstance(refs_map, dict) and refs_map:
            return [
                {"name": v[0], "length": int(v[1])}
                for _, v in sorted(refs_map.items())
            ]

        # Fallback 2: dict-style header (older/other bamnostic builds)
        if hasattr(header, "get"):
            sq = header.get("SQ", []) or []
            return [{"name": s["SN"], "length": int(s["LN"])} for s in sq]

        return []

    def _resolve_chrom(self, chrom: str) -> str:
        """Map a requested chromosome name to one the BAM actually has.

        Matches exact names first, then with/without a leading 'chr', then
        case-insensitively, then by accession base (strip a trailing
        '.version'). Returns the original name unchanged when nothing matches
        (bamnostic.fetch then raises KeyError, which the callers turn into an
        empty result) — it NEVER silently remaps to a different contig, which
        previously made single-contig BAMs serve the wrong data under any
        requested name.
        """
        names = [c["name"] for c in self.chromosomes]
        if chrom in names:
            return chrom

        target = _norm_chrom(chrom)
        for name in names:
            if _norm_chrom(name) == target:
                return name

        chrom_base = chrom.rsplit(".", 1)[0] if "." in chrom else chrom
        for name in names:
            name_base = name.rsplit(".", 1)[0] if "." in name else name
            if name_base == chrom_base:
                return name
        return chrom

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> dict:
        """Binned read depth over [start, end): exact mean / max / min per bin.

        Served from the background coverage index; bins the index has not
        reached yet come back ``pending``. If the index is unavailable (very
        large reference, or the scan failed) a bounded live pileup is used
        instead and the result is flagged ``truncated`` when its read cap was
        hit — never silently drawn as zero coverage."""
        chrom = self._resolve_chrom(chrom)
        if end - start <= 0:
            return {"bins": [], "meta": {}}
        state = self._cov.state
        if state in ("building", "ready"):
            if not self._cov.has_contig(chrom):
                return {"bins": [], "meta": {"coverage_state": state}}   # contig not in this BAM
            bins_data = self._cov.coverage(chrom, start, end, bins)
            if bins_data:
                return {"bins": bins_data, "meta": {
                    "coverage_state": self._cov.state,
                    "coverage_progress": self._cov.progress,
                }}
        # Index unavailable (reference too large for it, or the scan failed).
        bins_data, truncated = self._live_coverage(chrom, start, end, bins)
        return {"bins": bins_data, "meta": {
            "coverage_state": self._cov.state,
            "coverage_error": self._cov.error,
            "truncated": truncated,
        }}

    def _live_coverage(self, chrom, start, end, bins):
        """Fallback pileup when the coverage index is unavailable: mean depth of
        aligned bases per bin, bounded by MAX_COVERAGE_READS.

        Fixes over the original implementation: the range is clamped to the
        contig (bamnostic raises for a start past the contig end), each read
        is counted once — in the 50 kb chunk where it starts — instead of once
        per chunk it overlaps, and bins beyond the read cap are flagged
        ``pending`` rather than reported as zero. Returns (bins, truncated)."""
        L = self._contig_length(chrom)
        region_len = end - start
        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        edges = [start + int(i * bin_size) for i in range(n_bins)] + [end]
        sums = [0] * n_bins
        lo, hi = max(0, start), min(end, L)
        truncated = False
        complete_to = hi

        def add(a, b):
            k = min(n_bins - 1, max(0, int((a - start) / bin_size)))
            while k > 0 and edges[k] > a:
                k -= 1
            while k < n_bins and edges[k] < b:
                ov = min(b, edges[k + 1]) - max(a, edges[k])
                if ov > 0:
                    sums[k] += ov
                k += 1

        if hi > lo:
            CHUNK = 50_000
            total = 0
            try:
                cs = lo
                while cs < hi and not truncated:
                    ce = min(cs + CHUNK, hi)
                    fetch_from = max(0, cs - DEFAULT_READ_LOOKBACK) if cs == lo else cs
                    for read in self._aln.fetch(chrom, fetch_from, ce):
                        rs = read.reference_start
                        if cs != lo and rs < cs:
                            continue            # already counted in the chunk where it starts
                        if read.flag & SKIP_FLAGS or not read.cigarstring:
                            continue
                        p = rs
                        for ln, op in _parse_cigar(read.cigarstring):
                            if op in "M=X":
                                a, b = max(p, lo), min(p + ln, hi)
                                if b > a:
                                    add(a, b)
                                p += ln
                            elif op in "DN":
                                p += ln
                        total += 1
                        if total >= MAX_COVERAGE_READS:
                            truncated = True
                            complete_to = max(lo, rs)
                            break
                    cs = ce
            except KeyError:
                return [], False   # contig absent from this BAM
            except Exception as e:
                # Corrupt index / BGZF decode failure mid-fetch: a clear message
                # (HTTP 503) rather than a track that looks valid but is wrong.
                raise RuntimeError(_fetch_error_msg(self.file_path)) from e

        out = []
        for i in range(n_bins):
            a, b = edges[i], edges[i + 1]
            d = {"start": a, "end": b}
            ac, bc = max(a, 0), min(b, L)
            if bc <= ac:
                d.update(value=0.0, cov=0)
            elif bc > complete_to:
                d.update(value=0.0, cov=0, pending=True)
            else:
                d.update(value=sums[i] / (bc - ac), cov=bc - ac)
            out.append(d)
        return out, truncated

    def get_reads(self, chrom: str, start: int, end: int, is_current=None) -> dict:
        """Individual read alignments overlapping [start, end), with parsed CIGAR
        operations. Returns {"reads", "truncated", "total", "total_exact"}.

        - Fetches from further left and re-checks overlap against the true
          reference span (bamnostic's own test uses the sequence length and
          silently drops long reads that start left of the window).
        - QC-fail and duplicate reads are hidden (IGV defaults).
        - When more than MAX_READS_RETURNED reads overlap the window they are
          downsampled UNIFORMLY across it (a cap per sampling window, as IGV
          does) — previously the first 5,000 by position were kept, leaving the
          rest of a deep view blank. ``truncated`` says the pileup is a sample;
          ``total`` is the number of overlapping reads (a lower bound when
          ``total_exact`` is False because MAX_READS_SCANNED was reached).
        - ``is_current`` (optional) is polled while scanning; when it returns
          False a newer request has superseded this one and the scan stops.
        """
        chrom = self._resolve_chrom(chrom)
        L = self._contig_length(chrom)
        empty = {"reads": [], "truncated": False, "total": 0, "total_exact": True}
        if (L and start >= L) or end <= start:
            return empty
        lookback = self._cov.max_span(chrom)
        if lookback is None:
            lookback = DEFAULT_READ_LOOKBACK
        fetch_end = min(end, L) if L else end
        span = end - start
        window = max(50, span // 200)                    # sampling windows across the view
        per_window = max(1, -(-MAX_READS_RETURNED // -(-span // window)))
        kept = [0] * (-(-span // window))
        reads = []
        total = 0
        total_exact = True
        try:
            for read in self._aln.fetch(chrom, max(0, start - lookback), fetch_end):
                if read.is_unmapped or (read.flag & READ_VIEW_SKIP_FLAGS):
                    continue
                rs = read.reference_start
                re = read.reference_end if read.reference_end else rs + 1
                if re <= start or rs >= end:
                    continue
                total += 1
                if total % 2000 == 0:
                    if total >= MAX_READS_SCANNED:
                        total_exact = False
                        break
                    if is_current is not None and not is_current():
                        break                             # superseded: the client has moved on
                w = (rs - start) // window if rs > start else 0
                if kept[w] >= per_window:
                    continue                              # downsampled
                kept[w] += 1
                cigar = read.cigarstring or ""

                # Parse CIGAR into segments for rendering
                segments = _cigar_to_segments(rs, cigar)

                reads.append({
                    "start":    rs,
                    "end":      re,
                    "strand":   "-" if read.is_reverse else "+",
                    "name":     read.query_name or "",
                    "mapq":     read.mapping_quality or 0,
                    "cigar":    cigar,
                    "segments": segments,
                    "sequence": read.query_sequence or "",
                    "row":      0,
                })
        except (KeyError, IndexError):
            # Contig absent from this BAM, or present but without index
            # intervals (no reads on it): an empty view, not a corrupt file.
            return empty
        except ValueError as e:
            if "out of bounds" in str(e):
                return empty
            raise RuntimeError(_fetch_error_msg(self.file_path)) from e
        except Exception as e:
            # Corrupt/truncated BAM or index surfacing mid-fetch as a low-level
            # struct/decode error — convert to a clear, actionable message.
            raise RuntimeError(_fetch_error_msg(self.file_path)) from e

        _assign_rows(reads)
        return {"reads": reads, "truncated": total > len(reads) or not total_exact,
                "total": total, "total_exact": total_exact}


def _cigar_to_segments(ref_pos: int, cigar: str) -> list[dict]:
    """Convert a CIGAR string into visual segments for the frontend.

    Returns a list of dicts, each with:
      type: 'M' (match/mismatch), 'D' (deletion), 'I' (insertion),
            'N' (skip), 'S' (soft-clip)
      start: reference position (for M/D/N)
      end:   reference position end (for M/D/N)
      pos:   reference position where insertion occurs (for I)
      length: number of inserted bases (for I)
    """
    if not cigar:
        return []

    ops = _parse_cigar(cigar)
    segments = []
    pos = ref_pos

    for length, op in ops:
        if op in ('M', '=', 'X'):
            # Match or mismatch — consumes both query and reference
            segments.append({"type": "M", "start": pos, "end": pos + length})
            pos += length
        elif op == 'D':
            # Deletion from reference — consumes reference only
            segments.append({"type": "D", "start": pos, "end": pos + length})
            pos += length
        elif op == 'N':
            # Skipped region (intron) — consumes reference only
            segments.append({"type": "N", "start": pos, "end": pos + length})
            pos += length
        elif op == 'I':
            # Insertion to reference — consumes query only, mark position
            segments.append({"type": "I", "pos": pos, "length": length})
        elif op == 'S':
            # Soft clip — consumes query only, note at current pos
            segments.append({"type": "S", "pos": pos, "length": length})
        # H (hard clip) and P (padding) don't consume either — skip

    return segments


def _assign_rows(reads: list[dict]):
    """Greedy row assignment so reads don't overlap visually."""
    row_ends: list[int] = []
    for r in sorted(reads, key=lambda x: x["start"]):
        placed = False
        for i, end in enumerate(row_ends):
            if r["start"] >= end:
                r["row"] = i
                row_ends[i] = r["end"]
                placed = True
                break
        if not placed:
            r["row"] = len(row_ends)
            row_ends.append(r["end"])
