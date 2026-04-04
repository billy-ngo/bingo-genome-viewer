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

        bin_size = max(1, region_len // bins)
        result = []
        for b in range(0, region_len, bin_size):
            chunk = depth[b: b + bin_size]
            result.append({
                "start": start + b,
                "end":   min(start + b + bin_size, end),
                "value": sum(chunk) / len(chunk) if chunk else 0.0,
            })
        return result

    def get_reads(self, chrom: str, start: int, end: int) -> list[dict]:
        """Return individual read alignments for zoomed-in view."""
        chrom = self._resolve_chrom(chrom)
        reads = []
        try:
            for read in self._aln.fetch(chrom, start, end):
                if read.is_unmapped:
                    continue
                rs = read.reference_start
                re = read.reference_end if read.reference_end else rs + 1
                reads.append({
                    "start":    rs,
                    "end":      re,
                    "strand":   "-" if read.is_reverse else "+",
                    "name":     read.query_name or "",
                    "mapq":     read.mapping_quality or 0,
                    "cigar":    read.cigarstring or "",
                    "sequence": read.query_sequence or "",
                    "row":      0,
                })
                if len(reads) >= MAX_READS_RETURNED:
                    break
        except KeyError:
            return []  # chromosome not in index

        _assign_rows(reads)
        return reads


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
