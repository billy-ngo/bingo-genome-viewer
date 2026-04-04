"""
Annotation readers for BED, GTF, and GFF3 formats.
All load into memory once; index by chromosome for fast region queries.
"""

from pathlib import Path
import re


class BedReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._features: dict[str, list] = {}
        self._chroms: dict[str, int] = {}
        self._load()

    def _load(self):
        with open(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("#", "track", "browser")):
                    continue
                parts = line.split("\t")
                if len(parts) < 3:
                    parts = line.split()
                if len(parts) < 3:
                    continue
                chrom = parts[0]
                start = int(parts[1])
                end = int(parts[2])
                name = parts[3] if len(parts) > 3 else f"{chrom}:{start}-{end}"
                score = parts[4] if len(parts) > 4 else "0"
                strand = parts[5] if len(parts) > 5 else "."
                feat = {
                    "start": start,
                    "end": end,
                    "strand": strand,
                    "name": name,
                    "feature_type": "region",
                    "attributes": {"score": score},
                    "sub_features": [],
                }
                self._features.setdefault(chrom, []).append(feat)
                self._chroms[chrom] = max(self._chroms.get(chrom, 0), end)

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chroms.items()]

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._features:
            return chrom
        if len(self._features) == 1:
            return next(iter(self._features))
        for key in self._features:
            if key.replace("chr", "") == chrom.replace("chr", ""):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def get_features(self, chrom: str, start: int, end: int) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        return [f for f in self._features.get(chrom, [])
                if f["end"] > start and f["start"] < end]


class GtfReader:
    """Parses GTF2/GTF3; groups exons/CDS under their parent transcript."""

    def __init__(self, file_path: str):
        self.file_path = file_path
        self._genes: dict[str, list] = {}
        self._chroms: dict[str, int] = {}
        self._load()

    def _load(self):
        transcripts: dict[str, dict] = {}
        orphans: dict[str, list] = {}

        with open(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 9:
                    continue
                chrom, source, ftype, start, end, score, strand, frame, attrs_raw = parts
                start, end = int(start) - 1, int(end)  # convert to 0-based half-open
                attrs = _parse_gtf_attrs(attrs_raw)
                self._chroms[chrom] = max(self._chroms.get(chrom, 0), end)

                if ftype in ("gene",):
                    name = attrs.get("gene_name") or attrs.get("gene_id") or ftype
                    feat = {
                        "start": start, "end": end, "strand": strand,
                        "name": name, "feature_type": ftype,
                        "attributes": attrs, "sub_features": [],
                    }
                    self._genes.setdefault(chrom, []).append(feat)

                elif ftype in ("transcript", "mRNA"):
                    tid = attrs.get("transcript_id", "")
                    name = attrs.get("transcript_name") or attrs.get("gene_name") or tid
                    transcripts[tid] = {
                        "start": start, "end": end, "strand": strand,
                        "name": name, "feature_type": ftype,
                        "attributes": attrs, "sub_features": [],
                        "_chrom": chrom,
                    }

                elif ftype in ("exon", "CDS", "UTR", "start_codon", "stop_codon"):
                    tid = attrs.get("transcript_id", "")
                    sf = {
                        "start": start, "end": end, "strand": strand,
                        "name": ftype, "feature_type": ftype,
                        "attributes": attrs, "sub_features": [],
                    }
                    if tid in transcripts:
                        transcripts[tid]["sub_features"].append(sf)
                    else:
                        orphans.setdefault(chrom, []).append(sf)

        # Attach transcripts to gene lists (or add directly if no gene parent)
        for tid, tr in transcripts.items():
            chrom = tr.pop("_chrom")
            # Find parent gene
            gene_id = tr["attributes"].get("gene_id", "")
            parent = None
            for g in self._genes.get(chrom, []):
                if g["attributes"].get("gene_id") == gene_id:
                    parent = g
                    break
            if parent:
                parent["sub_features"].append(tr)
            else:
                self._genes.setdefault(chrom, []).append(tr)

        # Add orphan sub-features directly
        for chrom, feats in orphans.items():
            self._genes.setdefault(chrom, []).extend(feats)

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chroms.items()]

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._genes:
            return chrom
        if len(self._genes) == 1:
            return next(iter(self._genes))
        for key in self._genes:
            if key.replace("chr", "") == chrom.replace("chr", ""):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def get_features(self, chrom: str, start: int, end: int) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        return [f for f in self._genes.get(chrom, [])
                if f["end"] > start and f["start"] < end]


class Gff3Reader:
    """Parses GFF3; builds parent-child hierarchy using ID/Parent attributes."""

    def __init__(self, file_path: str):
        self.file_path = file_path
        self._top_level: dict[str, list] = {}
        self._chroms: dict[str, int] = {}
        self._load()

    def _load(self):
        by_id: dict[str, dict] = {}
        chrom_map: dict[str, str] = {}

        with open(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 9:
                    continue
                chrom, source, ftype, start, end, score, strand, frame, attrs_raw = parts
                start, end = int(start) - 1, int(end)
                attrs = _parse_gff3_attrs(attrs_raw)
                self._chroms[chrom] = max(self._chroms.get(chrom, 0), end)

                fid = attrs.get("ID", "")
                name = attrs.get("Name") or attrs.get("gene") or attrs.get("locus_tag") or ftype
                feat = {
                    "start": start, "end": end, "strand": strand,
                    "name": name, "feature_type": ftype,
                    "attributes": attrs, "sub_features": [],
                    "_chrom": chrom,
                }
                if fid:
                    by_id[fid] = feat

                parent_ids = attrs.get("Parent", "").split(",")
                if parent_ids and parent_ids[0]:
                    for pid in parent_ids:
                        pid = pid.strip()
                        if pid in by_id:
                            by_id[pid]["sub_features"].append(feat)
                        # else defer; GFF3 may not be ordered
                else:
                    self._top_level.setdefault(chrom, []).append(feat)

        # Second pass: attach any deferred children
        for fid, feat in by_id.items():
            parent_ids = feat["attributes"].get("Parent", "").split(",")
            if parent_ids and parent_ids[0]:
                for pid in parent_ids:
                    pid = pid.strip()
                    if pid in by_id:
                        # Check not already added
                        if feat not in by_id[pid]["sub_features"]:
                            by_id[pid]["sub_features"].append(feat)
            else:
                chrom = feat["_chrom"]
                if feat not in self._top_level.get(chrom, []):
                    self._top_level.setdefault(chrom, []).append(feat)

        # Remove _chrom helper
        for feats in self._top_level.values():
            for f in feats:
                f.pop("_chrom", None)
        for f in by_id.values():
            f.pop("_chrom", None)

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chroms.items()]

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._top_level:
            return chrom
        if len(self._top_level) == 1:
            return next(iter(self._top_level))
        for key in self._top_level:
            if key.replace("chr", "") == chrom.replace("chr", ""):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def get_features(self, chrom: str, start: int, end: int) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        return [f for f in self._top_level.get(chrom, [])
                if f["end"] > start and f["start"] < end]


# ── helpers ──────────────────────────────────────────────────────────────────

def _parse_gtf_attrs(raw: str) -> dict:
    attrs = {}
    for m in re.finditer(r'(\w+)\s+"([^"]+)"', raw):
        attrs[m.group(1)] = m.group(2)
    return attrs


def _parse_gff3_attrs(raw: str) -> dict:
    attrs = {}
    for item in raw.split(";"):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            attrs[k.strip()] = v.strip()
    return attrs


def make_annotation_reader(file_path: str):
    ext = Path(file_path).suffix.lower()
    if ext == ".bed":
        return BedReader(file_path)
    elif ext in (".gtf", ".gff", ".gff2"):
        return GtfReader(file_path)
    elif ext == ".gff3":
        return Gff3Reader(file_path)
    else:
        raise ValueError(f"Unsupported annotation format: {ext}")
