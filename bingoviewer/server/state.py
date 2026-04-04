"""
Global application state — holds the loaded genome and track readers.
Single-process in-memory store; safe for a local desktop app.
"""

import uuid
from pathlib import Path
from typing import Any


class AppState:
    def __init__(self):
        self.genome = None                  # GenomeReader instance
        self.tracks: dict[str, dict] = {}   # track_id -> TrackInfo dict
        self.readers: dict[str, Any] = {}   # track_id -> reader instance

    def load_genome(self, file_path: str):
        from readers.genome_reader import GenomeReader
        self.genome = GenomeReader(file_path)
        # If GenBank, auto-add annotation track
        if self.genome.is_annotated():
            track_id = "genome_annotations"
            self.tracks[track_id] = {
                "id": track_id,
                "name": f"{self.genome.name} (annotations)",
                "file_path": file_path,
                "track_type": "genome_annotations",
                "file_format": "genbank",
            }
            self.readers[track_id] = None  # served directly from genome reader

    def load_track(self, file_path: str, name: str) -> dict:
        ext = Path(file_path).suffix.lower()
        track_id = str(uuid.uuid4())[:8]

        if ext in (".bam", ".cram", ".sam"):
            from readers.bam_reader import BamReader
            reader = BamReader(file_path)
            track_type = "reads"
            file_format = ext.lstrip(".")

        elif ext in (".bw", ".bigwig", ".bedgraph", ".bdg", ".wig"):
            from readers.bigwig_reader import make_coverage_reader
            reader = make_coverage_reader(file_path)
            track_type = "coverage"
            file_format = ext.lstrip(".")

        elif ext in (".vcf", ".vcf.gz", ".bcf"):
            from readers.vcf_reader import VcfReader
            reader = VcfReader(file_path)
            track_type = "variants"
            file_format = "vcf"

        elif ext in (".bed", ".gtf", ".gff", ".gff2", ".gff3"):
            from readers.annotation_reader import make_annotation_reader
            reader = make_annotation_reader(file_path)
            track_type = "annotations"
            file_format = ext.lstrip(".")

        elif ext in (".gb", ".gbk", ".genbank"):
            from readers.genbank_reader import GenBankReader
            reader = GenBankReader(file_path)
            track_type = "annotations"
            file_format = "genbank"

        else:
            raise ValueError(f"Unsupported file format: {ext}")

        info = {
            "id": track_id,
            "name": name,
            "file_path": file_path,
            "track_type": track_type,
            "file_format": file_format,
        }
        self.tracks[track_id] = info
        self.readers[track_id] = reader
        return info

    def check_track_compatibility(self, track_id: str) -> dict:
        """Compare a track reader's chromosomes against the loaded genome.

        Returns a dict with ``status`` ('ok', 'mismatch', or 'size_mismatch')
        and a human-readable ``message`` when there is a problem.
        """
        if self.genome is None:
            return {"status": "no_genome"}

        reader = self.readers.get(track_id)
        if reader is None or not hasattr(reader, "chromosomes"):
            return {"status": "ok"}

        try:
            track_chroms = {
                c["name"]: c.get("length", 0) for c in reader.chromosomes
            }
        except Exception:
            return {"status": "ok"}  # can't read chromosomes; skip check

        if not track_chroms:
            return {"status": "ok"}

        genome_chroms = {c["name"]: c["length"] for c in self.genome.chromosomes}
        matching_names = set(track_chroms) & set(genome_chroms)

        # ── Single-chromosome special case ──
        # Many bacterial tracks have one chromosome with a different name
        # than the genome.  The _resolve_chrom() fallbacks in readers handle
        # this transparently, so we only warn when the *sizes* differ.
        if len(track_chroms) == 1 and len(genome_chroms) == 1:
            t_name, t_len = next(iter(track_chroms.items()))
            g_name, g_len = next(iter(genome_chroms.items()))
            if t_len > 0 and g_len > 0:
                ratio = abs(t_len - g_len) / max(g_len, 1)
                if ratio > 0.05:
                    return {
                        "status": "size_mismatch",
                        "message": (
                            f"Chromosome size mismatch: track '{t_name}' "
                            f"({t_len:,} bp) vs genome '{g_name}' ({g_len:,} bp)"
                        ),
                        "track_chromosomes": list(track_chroms.keys()),
                        "genome_chromosomes": list(genome_chroms.keys()),
                    }
            return {"status": "ok"}

        # ── Multi-chromosome: check name overlap ──
        if not matching_names:
            t_sample = sorted(track_chroms)[:5]
            g_sample = sorted(genome_chroms)[:5]
            return {
                "status": "mismatch",
                "message": (
                    f"No matching chromosomes found. "
                    f"Track: {', '.join(t_sample)}; "
                    f"Genome: {', '.join(g_sample)}"
                ),
                "track_chromosomes": list(track_chroms.keys()),
                "genome_chromosomes": list(genome_chroms.keys()),
            }

        # ── Check size mismatches for matching names ──
        size_issues = []
        for name in matching_names:
            t_len = track_chroms[name]
            g_len = genome_chroms[name]
            if t_len > 0 and g_len > 0:
                ratio = abs(t_len - g_len) / max(g_len, 1)
                if ratio > 0.05:
                    size_issues.append(name)

        if size_issues:
            ex = size_issues[0]
            return {
                "status": "size_mismatch",
                "message": (
                    f"Size mismatch on {', '.join(size_issues[:3])}: "
                    f"e.g. '{ex}' is {genome_chroms[ex]:,} bp in genome "
                    f"but {track_chroms[ex]:,} bp in track"
                ),
                "track_chromosomes": list(track_chroms.keys()),
                "genome_chromosomes": list(genome_chroms.keys()),
            }

        return {"status": "ok"}

    def get_target_chromosomes(self, track_id: str) -> list:
        """Return the list of genome chromosome names this track can serve.

        Used by the frontend to hide tracks when the user switches to a
        chromosome that the track has no data for.
        """
        if self.genome is None:
            return []

        genome_chroms = self.genome.chromosomes
        all_names = [c["name"] for c in genome_chroms]

        # Genome annotation tracks → only chromosomes from GenBank files
        if track_id == "genome_annotations":
            annotated = self.genome.annotated_chromosomes
            return annotated if annotated else all_names

        reader = self.readers.get(track_id)
        if reader is None or not hasattr(reader, "chromosomes"):
            return all_names

        try:
            track_chroms = reader.chromosomes
            track_names = {c["name"] for c in track_chroms}
            track_sizes = {c["name"]: c.get("length", 0) for c in track_chroms}
        except Exception:
            return all_names

        if not track_names:
            return all_names

        # Single-chrom track + single-chrom genome → reader fallback handles
        # the name mismatch, so map to the genome's chromosome.
        if len(track_names) == 1 and len(genome_chroms) == 1:
            return [genome_chroms[0]["name"]]

        # Multi-chrom: exact name matches
        matched = [gc["name"] for gc in genome_chroms if gc["name"] in track_names]
        if matched:
            return matched

        # No exact name match with a single-chrom track → find closest by size
        if len(track_names) == 1:
            t_len = next(iter(track_sizes.values()))
            if t_len > 0:
                best, best_r = None, 1.0
                for gc in genome_chroms:
                    if gc["length"] > 0:
                        r = abs(gc["length"] - t_len) / max(gc["length"], 1)
                        if r < best_r:
                            best_r, best = r, gc["name"]
                if best and best_r <= 0.05:
                    return [best]

        # Fallback: user chose "Load Anyway" — show on all
        return all_names

    def remove_track(self, track_id: str):
        reader = self.readers.pop(track_id, None)
        if reader and hasattr(reader, "close"):
            reader.close()
        self.tracks.pop(track_id, None)


app_state = AppState()
