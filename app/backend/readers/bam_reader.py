"""
BAM reader — uses bamnostic (pure Python, Windows-compatible).
Requires a .bai index alongside the BAM file for random-access queries.
CRAM is not supported by bamnostic; use BAM instead.
"""

from pathlib import Path

import bamnostic as bam

MAX_READS_RETURNED = 5000
READ_DETAIL_THRESHOLD = 50_000  # bp

# Standard index naming conventions: file.bam.bai and file.bai
_INDEX_SUFFIXES = (".bam.bai", ".bai")


def _find_index(bam_path: str) -> str | None:
    """Locate a .bai index for the given BAM file.

    Checks both naming conventions (.bam.bai and .bai) in the same
    directory as the BAM file.
    """
    p = Path(bam_path)
    for candidate in (
        p.parent / (p.name + ".bai"),   # reads.bam.bai
        p.with_suffix(".bai"),           # reads.bai
    ):
        if candidate.exists():
            return str(candidate)
    return None


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


class BamReader:
    def __init__(self, file_path: str):
        self.file_path = file_path

        # Validate BAM file exists
        if not Path(file_path).exists():
            raise FileNotFoundError(f"BAM file not found: {file_path}")

        # Validate index exists before opening
        index_path = _find_index(file_path)
        if index_path is None:
            bam_name = Path(file_path).name
            raise FileNotFoundError(
                f"BAM index (.bai) not found for '{bam_name}'. "
                f"Please provide a .bai file alongside the BAM file "
                f"(expected '{bam_name}.bai' or '{Path(bam_name).stem}.bai')."
            )

        self._aln = bam.AlignmentFile(file_path, "rb", index_filename=index_path)

    def close(self):
        self._aln.close()

    @property
    def chromosomes(self) -> list[dict]:
        header = self._aln.header
        sq = header.get("SQ", [])
        return [{"name": s["SN"], "length": s["LN"]} for s in sq]

    def _resolve_chrom(self, chrom: str) -> str:
        chroms = self.chromosomes
        names = [c["name"] for c in chroms]
        if chrom in names:
            return chrom
        if len(names) == 1:
            return names[0]
        for name in names:
            if name.replace("chr", "") == chrom.replace("chr", ""):
                return name
            if name.lower() == chrom.lower():
                return name
        return chrom

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        """Return binned coverage by piling up fetched reads."""
        chrom = self._resolve_chrom(chrom)
        region_len = end - start
        if region_len <= 0:
            return []

        depth = [0] * region_len
        try:
            for read in self._aln.fetch(chrom, start, end):
                if read.is_unmapped:
                    continue
                rs = read.reference_start
                re = read.reference_end if read.reference_end else rs + 1
                lo = max(rs, start) - start
                hi = min(re, end) - start
                for i in range(lo, hi):
                    depth[i] += 1
        except KeyError:
            return []  # chromosome not in index

        # Use floating-point bin boundaries to avoid gaps from integer rounding
        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        result = []
        for i in range(n_bins):
            b_start = int(start + i * bin_size)
            b_end = int(start + (i + 1) * bin_size)
            lo = b_start - start
            hi = b_end - start
            chunk = depth[lo:hi]
            result.append({
                "start": b_start,
                "end":   b_end,
                "value": sum(chunk) / len(chunk) if chunk else 0.0,
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
