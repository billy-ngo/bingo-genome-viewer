"""
Genome reader — supports FASTA (via pyfaidx) and GenBank (via BioPython).
Auto-detects format from file extension.  Supports merging chromosomes from
multiple files via add_chromosomes_from().
"""

from pathlib import Path
from typing import List, Dict


class GenomeReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._sub_readers: List[tuple] = []  # [(format, reader), ...]
        self._add_file(file_path)

    @staticmethod
    def _detect_format(file_path: str) -> str:
        ext = Path(file_path).suffix.lower()
        return "genbank" if ext in (".gb", ".gbk", ".genbank") else "fasta"

    def _add_file(self, file_path: str):
        fmt = self._detect_format(file_path)
        if fmt == "genbank":
            from readers.genbank_reader import GenBankReader
            reader = GenBankReader(file_path)
        else:
            from pyfaidx import Fasta
            reader = Fasta(file_path)
        self._sub_readers.append((fmt, reader))

    def add_chromosomes_from(self, file_path: str):
        """Load another file and merge its chromosomes into this genome."""
        self._add_file(file_path)

    @property
    def name(self) -> str:
        return Path(self.file_path).stem

    @property
    def chromosomes(self) -> List[Dict]:
        result = []
        for fmt, reader in self._sub_readers:
            if fmt == "genbank":
                result.extend(reader.chromosomes)
            else:
                result.extend(
                    [{"name": k, "length": len(reader[k])} for k in reader.keys()]
                )
        return result

    def get_sequence(self, chrom: str, start: int, end: int) -> str:
        """0-based half-open [start, end)."""
        for fmt, reader in self._sub_readers:
            if fmt == "genbank":
                try:
                    return reader.get_sequence(chrom, start, end)
                except KeyError:
                    continue
            else:
                if chrom in reader:
                    return str(reader[chrom][start:end])
        raise KeyError(f"Chromosome '{chrom}' not found")

    def get_features(self, chrom: str, start: int, end: int) -> List[Dict]:
        """Only GenBank files carry annotation features."""
        for fmt, reader in self._sub_readers:
            if fmt == "genbank":
                try:
                    return reader.get_features(chrom, start, end)
                except KeyError:
                    continue
        return []

    def is_annotated(self) -> bool:
        return any(fmt == "genbank" for fmt, _ in self._sub_readers)
