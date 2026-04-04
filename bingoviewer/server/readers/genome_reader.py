"""
Genome reader — supports FASTA (via pyfaidx) and GenBank (via BioPython).
Auto-detects format from file extension.
"""

from pathlib import Path
from typing import List, Dict


class GenomeReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        ext = Path(file_path).suffix.lower()
        self._format = "genbank" if ext in (".gb", ".gbk", ".genbank") else "fasta"
        self._reader = self._init_reader()

    def _init_reader(self):
        if self._format == "genbank":
            from readers.genbank_reader import GenBankReader
            return GenBankReader(self.file_path)
        else:
            from pyfaidx import Fasta
            return Fasta(self.file_path)

    @property
    def name(self) -> str:
        return Path(self.file_path).stem

    @property
    def chromosomes(self) -> List[Dict]:
        if self._format == "genbank":
            return self._reader.chromosomes
        else:
            return [{"name": k, "length": len(self._reader[k])} for k in self._reader.keys()]

    def get_sequence(self, chrom: str, start: int, end: int) -> str:
        """0-based half-open [start, end)."""
        if self._format == "genbank":
            return self._reader.get_sequence(chrom, start, end)
        else:
            return str(self._reader[chrom][start:end])

    def get_features(self, chrom: str, start: int, end: int) -> List[Dict]:
        """Only GenBank files carry annotation features."""
        if self._format == "genbank":
            return self._reader.get_features(chrom, start, end)
        return []

    def is_annotated(self) -> bool:
        return self._format == "genbank"
