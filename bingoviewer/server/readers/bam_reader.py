"""
BAM reader — uses bamnostic (pure Python, Windows-compatible).
Requires a .bai index alongside the BAM file for random-access queries.
CRAM and SAM are not supported by bamnostic; convert to an indexed BAM.
"""

from pathlib import Path
from typing import Optional

import bamnostic as bam

MAX_READS_RETURNED = 5000
MAX_COVERAGE_READS = 500_000   # cap reads iterated for coverage computation
READ_DETAIL_THRESHOLD = 50_000  # bp

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

    def close(self):
        try:
            self._aln.close()
        except Exception:
            pass

    @property
    def chromosomes(self) -> list[dict]:
        """Reference contigs as [{name, length}].

        Reads from bamnostic's authoritative binary reference block via the
        pysam-compatible ``references``/``lengths`` tuples (always present,
        regardless of whether the BAM carries an @SQ SAM *text* header). The
        previous implementation used ``header.get('SQ')`` which raises
        ``AttributeError`` on bamnostic's ``BAMheader`` object (it is not a
        dict) — i.e. it broke for *every* BAM. Falls back to the raw refs
        map, then to a dict-style header, for resilience across versions.
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

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        """Return binned coverage by piling up fetched reads.

        For large regions, splits into sub-regions (50kb chunks) to ensure
        bamnostic's index-based fetch covers the entire span reliably.
        Large BAM files can fail to return all reads from a single huge
        fetch spanning millions of bases.
        """
        chrom = self._resolve_chrom(chrom)
        region_len = end - start
        if region_len <= 0:
            return []

        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        counts = [0.0] * n_bins

        # Split large regions into chunks for reliable index traversal
        CHUNK_SIZE = 50_000
        total_reads = 0

        try:
            chunk_start = start
            while chunk_start < end:
                chunk_end = min(chunk_start + CHUNK_SIZE, end)
                for read in self._aln.fetch(chrom, chunk_start, chunk_end):
                    if read.is_unmapped:
                        continue
                    rs = read.reference_start
                    re = read.reference_end if read.reference_end else rs + 1
                    rs = max(rs, start)
                    re = min(re, end)
                    if rs >= re:
                        continue
                    bi_start = int((rs - start) / bin_size)
                    bi_end = int((re - 1 - start) / bin_size) + 1
                    bi_start = max(0, min(bi_start, n_bins - 1))
                    bi_end = max(1, min(bi_end, n_bins))
                    for bi in range(bi_start, bi_end):
                        b_lo = start + bi * bin_size
                        b_hi = start + (bi + 1) * bin_size
                        overlap = min(re, b_hi) - max(rs, b_lo)
                        if overlap > 0:
                            counts[bi] += overlap / (b_hi - b_lo)
                    total_reads += 1
                    if total_reads >= MAX_COVERAGE_READS:
                        break
                if total_reads >= MAX_COVERAGE_READS:
                    break
                chunk_start = chunk_end
        except KeyError:
            # Chromosome genuinely absent from this BAM's index — a legitimate
            # empty result (e.g. a per-chromosome BAM viewed on another chrom).
            return []
        except Exception as e:
            # Corrupt index / BGZF decode failure mid-fetch. The previous
            # `except Exception: pass` returned whatever partial counts had
            # accumulated — a coverage track that looks valid but is silently
            # wrong. Convert to a clear message that data.py turns into an
            # HTTP 503 the frontend surfaces as an "update failed" warning,
            # rather than leaking a cryptic 'unpack requires a buffer' error.
            raise RuntimeError(_fetch_error_msg(self.file_path)) from e

        result = []
        for i in range(n_bins):
            b_start = int(start + i * bin_size)
            b_end = int(start + (i + 1) * bin_size)
            result.append({
                "start": b_start,
                "end":   b_end,
                "value": counts[i],
            })
        return result

    def get_reads(self, chrom: str, start: int, end: int) -> list[dict]:
        """Return individual read alignments with parsed CIGAR operations."""
        chrom = self._resolve_chrom(chrom)
        reads = []
        try:
            for read in self._aln.fetch(chrom, start, end):
                if read.is_unmapped:
                    continue
                rs = read.reference_start
                re = read.reference_end if read.reference_end else rs + 1
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
                if len(reads) >= MAX_READS_RETURNED:
                    break
        except KeyError:
            return []  # chromosome not in index
        except Exception as e:
            # Corrupt/truncated BAM or index surfacing mid-fetch as a low-level
            # struct/decode error — convert to a clear, actionable message.
            raise RuntimeError(_fetch_error_msg(self.file_path)) from e

        _assign_rows(reads)
        return reads


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
