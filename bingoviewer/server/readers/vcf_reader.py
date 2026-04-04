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
        self._chroms = []
        self._load()

    def _open(self):
        if self.file_path.endswith(".gz"):
            return gzip.open(self.file_path, "rt", encoding="utf-8")
        return open(self.file_path, "r", encoding="utf-8")

    def _load(self):
        with self._open() as f:
            for line in f:
                if line.startswith("##"):
                    continue
                if line.startswith("#CHROM"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 5:
                    continue
                chrom = parts[0]
                try:
                    pos = int(parts[1]) - 1   # convert to 0-based
                except ValueError:
                    continue
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

                variant = {
                    "chrom": chrom,
                    "pos": pos,
                    "ref": ref,
                    "alt": alts,
                    "qual": qual,
                    "filter": filt,
                    "info": info,
                }
                if chrom not in self._by_chrom:
                    self._by_chrom[chrom] = []
                    self._chroms.append({"name": chrom, "length": 0})
                self._by_chrom[chrom].append(variant)

        # Sort each chrom by position
        for variants in self._by_chrom.values():
            variants.sort(key=lambda v: v["pos"])

    def close(self):
        pass  # nothing to close for in-memory reader

    @property
    def chromosomes(self) -> list[dict]:
        return self._chroms

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._by_chrom:
            return chrom
        if len(self._by_chrom) == 1:
            return next(iter(self._by_chrom))
        return chrom

    def get_variants(self, chrom: str, start: int, end: int) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        variants = self._by_chrom.get(chrom, [])
        # Binary search for start
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
