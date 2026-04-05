"""
VCF reader — pure Python, no compiled dependencies.
Loads the file into memory on first access and indexes by chromosome.
Supports plain .vcf and gzip-compressed .vcf.gz.
"""

import gzip
from pathlib import Path


MAX_VARIANTS = 10_000


class VcfReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._by_chrom: dict[str, list[dict]] = {}
        self._chrom_lengths: dict[str, int] = {}
        self._chrom_order: list[str] = []
        self._load()

    def _open(self):
        if self.file_path.endswith(".gz"):
            return gzip.open(self.file_path, "rt", encoding="utf-8", errors="replace")
        return open(self.file_path, "r", encoding="utf-8", errors="replace")

    def _load(self):
        with self._open() as f:
            for line in f:
                if line.startswith("##"):
                    # Parse contig lengths from header if available
                    if line.startswith("##contig="):
                        self._parse_contig_header(line)
                    continue
                if line.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 5:
                    continue
                chrom = parts[0]
                try:
                    pos = int(parts[1]) - 1   # VCF is 1-based, convert to 0-based
                except ValueError:
                    continue
                vid = parts[2] if len(parts) > 2 and parts[2] != "." else None
                ref = parts[3]
                alt_raw = parts[4]
                alts = alt_raw.split(",") if alt_raw and alt_raw != "." else []
                qual = None
                try:
                    qual = float(parts[5]) if len(parts) > 5 and parts[5] not in (".", "") else None
                except ValueError:
                    pass
                filt = parts[6] if len(parts) > 6 and parts[6] else "."
                info = {}
                if len(parts) > 7 and parts[7] not in (".", ""):
                    for item in parts[7].split(";"):
                        if "=" in item:
                            k, v = item.split("=", 1)
                            info[k] = v
                        else:
                            info[item] = True

                # Compute variant end position based on REF length
                var_end = pos + len(ref)

                variant = {
                    "chrom": chrom,
                    "pos": pos,
                    "end": var_end,
                    "id": vid,
                    "ref": ref,
                    "alt": alts,
                    "qual": qual,
                    "filter": filt,
                    "info": info,
                }
                if chrom not in self._by_chrom:
                    self._by_chrom[chrom] = []
                    self._chrom_order.append(chrom)
                self._by_chrom[chrom].append(variant)
                # Track max position for chromosome length
                self._chrom_lengths[chrom] = max(
                    self._chrom_lengths.get(chrom, 0), var_end
                )

        # Sort each chrom by position
        for variants in self._by_chrom.values():
            variants.sort(key=lambda v: v["pos"])

    def _parse_contig_header(self, line: str):
        """Parse ##contig=<ID=chr1,length=248956422> header lines."""
        # Extract key=value pairs between < >
        content = line.split("<", 1)[-1].rstrip(">\n\r")
        parts = {}
        for item in content.split(","):
            if "=" in item:
                k, v = item.split("=", 1)
                parts[k] = v
        cid = parts.get("ID", "")
        length = parts.get("length", "0")
        if cid:
            try:
                self._chrom_lengths[cid] = max(
                    self._chrom_lengths.get(cid, 0), int(length)
                )
            except ValueError:
                pass

    def close(self):
        pass

    @property
    def chromosomes(self) -> list[dict]:
        return [
            {"name": c, "length": self._chrom_lengths.get(c, 0)}
            for c in self._chrom_order
        ]

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._by_chrom:
            return chrom
        if len(self._by_chrom) == 1:
            return next(iter(self._by_chrom))
        for key in self._by_chrom:
            if key.replace("chr", "") == chrom.replace("chr", ""):
                return key
            if key.lower() == chrom.lower():
                return key
        # Accession version stripping (NC_000001.11 matches NC_000001)
        chrom_base = chrom.rsplit(".", 1)[0] if "." in chrom else chrom
        for key in self._by_chrom:
            key_base = key.rsplit(".", 1)[0] if "." in key else key
            if key_base == chrom_base:
                return key
        return chrom

    def get_variants(self, chrom: str, start: int, end: int) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        variants = self._by_chrom.get(chrom, [])
        if not variants:
            return []
        # Binary search for start position
        lo, hi = 0, len(variants)
        while lo < hi:
            mid = (lo + hi) // 2
            if variants[mid]["pos"] < start:
                lo = mid + 1
            else:
                hi = mid
        results = []
        for v in variants[lo:]:
            if v["pos"] >= end:
                break
            results.append(v)
            if len(results) >= MAX_VARIANTS:
                break
        return results
