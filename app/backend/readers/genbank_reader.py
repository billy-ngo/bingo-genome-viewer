"""
GenBank reader — uses BioPython to parse .gb/.gbk files.
Provides chromosome list, reference sequence, and feature annotations.
"""

from pathlib import Path
from Bio import SeqIO
from Bio.SeqRecord import SeqRecord


class GenBankReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._records: dict[str, SeqRecord] = {}
        self._load()

    def _load(self):
        for record in SeqIO.parse(self.file_path, "genbank"):
            # Prefer LOCUS name; fall back to accession id; skip URN-style ids
            rid = record.id or ""
            rname = record.name or ""
            if rname and rname != "<unknown name>":
                chrom = rname
            elif rid and not rid.startswith("urn.") and rid != ".":
                chrom = rid
            else:
                # Last resort: use description or filename stem
                chrom = (record.description or Path(self.file_path).stem).split(",")[0].strip()
            self._records[chrom] = record

    @property
    def chromosomes(self) -> list[dict]:
        return [
            {"name": chrom, "length": len(record.seq)}
            for chrom, record in self._records.items()
        ]

    def get_sequence(self, chrom: str, start: int, end: int) -> str:
        """Return subsequence [start, end) (0-based half-open)."""
        record = self._get_record(chrom)
        return str(record.seq[start:end])

    def get_features(self, chrom: str, start: int, end: int) -> list[dict]:
        """Return features overlapping [start, end) as dicts."""
        record = self._get_record(chrom)
        results = []
        for feat in record.features:
            f_start = int(feat.location.start)
            f_end = int(feat.location.end)
            if f_end <= start or f_start >= end:
                continue
            if feat.type in ("source",):
                continue

            strand = "+" if feat.location.strand == 1 else ("-" if feat.location.strand == -1 else ".")
            qualifiers = {k: v[0] if isinstance(v, list) and len(v) == 1 else v
                          for k, v in feat.qualifiers.items()}

            name = (
                qualifiers.get("gene")
                or qualifiers.get("locus_tag")
                or qualifiers.get("product")
                or feat.type
            )

            results.append({
                "start": f_start,
                "end": f_end,
                "strand": strand,
                "name": name,
                "feature_type": feat.type,
                "attributes": qualifiers,
                "sub_features": [],
            })
        return results

    def _get_record(self, chrom: str) -> SeqRecord:
        if chrom in self._records:
            return self._records[chrom]
        # Single chromosome fallback (common for bacterial genomes)
        if len(self._records) == 1:
            return next(iter(self._records.values()))
        # Try matching by prefix or without version suffix
        for key in self._records:
            if key.startswith(chrom) or chrom.startswith(key):
                return self._records[key]
        raise KeyError(f"Chromosome '{chrom}' not found in GenBank file")
