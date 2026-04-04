"""
BAM reader — uses bamnostic (pure Python, Windows-compatible).
Requires a .bai index alongside the BAM file for random-access queries.
CRAM is not supported by bamnostic; use BAM instead.
"""

import bamnostic as bam
from typing import List, Dict

MAX_READS_RETURNED = 5000
READ_DETAIL_THRESHOLD = 50_000  # bp


class BamReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._aln = bam.AlignmentFile(file_path, "rb")

    def close(self):
        self._aln.close()

    @property
    def chromosomes(self) -> List[Dict]:
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

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> List[Dict]:
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
        except Exception:
            pass

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

    def get_reads(self, chrom: str, start: int, end: int) -> List[Dict]:
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
        except Exception:
            pass

        _assign_rows(reads)
        return reads


def _assign_rows(reads: List[Dict]):
    """Greedy row assignment so reads don't overlap visually."""
    row_ends: List[int] = []
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
