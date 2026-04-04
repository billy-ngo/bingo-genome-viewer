"""
Global application state — holds the loaded genome and track readers.
Single-process in-memory store; safe for a local desktop app.
"""

import uuid
from pathlib import Path
from typing import Dict, Optional, Any


class AppState:
    def __init__(self):
        self.genome = None                  # GenomeReader instance
        self.tracks: Dict[str, Dict] = {}   # track_id -> TrackInfo dict
        self.readers: Dict[str, Any] = {}   # track_id -> reader instance

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

    def load_track(self, file_path: str, name: str) -> Dict:
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

    def remove_track(self, track_id: str):
        reader = self.readers.pop(track_id, None)
        if reader and hasattr(reader, "close"):
            reader.close()
        self.tracks.pop(track_id, None)


app_state = AppState()
