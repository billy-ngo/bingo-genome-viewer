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

    @property
    def feature_types(self) -> list[str]:
        """Return sorted list of all feature types found across all records."""
        types: set[str] = set()
        for record in self._records.values():
            for feat in record.features:
                if feat.type and feat.type != "source":
                    types.add(feat.type)
        return sorted(types)

    def _build_search_index(self):
        """Build a flat, lowercased index of searchable feature names once."""
        index = []
        for chrom, record in self._records.items():
            for feat in record.features:
                if feat.type == "source":
                    continue
                quals = feat.qualifiers
                names = []
                for k in ("gene", "locus_tag", "product", "Name", "note"):
                    v = quals.get(k)
                    if not v:
                        continue
                    names.append(v[0] if isinstance(v, list) and v else str(v))
                if not names:
                    continue
                try:
                    fstart = int(feat.location.start)
                    fend = int(feat.location.end)
                except Exception:
                    continue
                for nm in names:
                    index.append((str(nm).lower(), str(nm), chrom, fstart, fend, feat.type))
        return index

    def search_features(self, q_lower: str, limit: int = 50) -> list[dict]:
        """Find genome features whose gene/locus_tag/product/name matches the
        query. relevance: 3=exact, 2=prefix, 1=substring."""
        if getattr(self, "_search_index", None) is None:
            self._search_index = self._build_search_index()
        # De-dup by (chrom, start, end) keeping the best relevance.
        best_by_loc: dict[tuple, dict] = {}
        for nm_lower, nm, chrom, start, end, ftype in self._search_index:
            if q_lower == nm_lower:
                rel = 3
            elif nm_lower.startswith(q_lower):
                rel = 2
            elif q_lower in nm_lower:
                rel = 1
            else:
                continue
            key = (chrom, start, end)
            prev = best_by_loc.get(key)
            if prev is None or rel > prev["relevance"]:
                best_by_loc[key] = {
                    "name": nm, "matched": nm, "chrom": chrom,
                    "start": start, "end": end,
                    "feature_type": ftype, "relevance": rel,
                }
        results = sorted(best_by_loc.values(), key=lambda r: (-r["relevance"], r["start"]))
        return results[:limit]

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
