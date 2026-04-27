"""
Genome reader — supports FASTA (via pyfaidx) and GenBank (via BioPython).
Auto-detects format from file extension.  Supports merging chromosomes from
multiple files via add_chromosomes_from().
"""

from pathlib import Path


class GenomeReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._sub_readers: list[tuple] = []  # [(format, reader), ...]
        self._chrom_index: dict[str, int] = {}  # chrom name → index in _sub_readers
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
        idx = len(self._sub_readers)
        self._sub_readers.append((fmt, reader))
        # Build explicit chromosome→reader index
        # Skip duplicates: first file's chromosome takes precedence
        if fmt == "genbank":
            for info in reader.chromosomes:
                if info["name"] not in self._chrom_index:
                    self._chrom_index[info["name"]] = idx
        else:
            for key in reader.keys():
                if key not in self._chrom_index:
                    self._chrom_index[key] = idx

    def add_chromosomes_from(self, file_path: str):
        """Load another file and merge its chromosomes into this genome."""
        self._add_file(file_path)

    @property
    def name(self) -> str:
        return Path(self.file_path).stem

    @property
    def chromosomes(self) -> list[dict]:
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
        idx = self._chrom_index.get(chrom)
        if idx is None:
            raise KeyError(f"Chromosome '{chrom}' not found")
        fmt, reader = self._sub_readers[idx]
        if fmt == "genbank":
            return reader.get_sequence(chrom, start, end)
        else:
            return str(reader[chrom][start:end])

    def get_features(self, chrom: str, start: int, end: int) -> list[dict]:
        """Only GenBank files carry annotation features."""
        idx = self._chrom_index.get(chrom)
        if idx is None:
            return []
        fmt, reader = self._sub_readers[idx]
        if fmt == "genbank":
            return reader.get_features(chrom, start, end)
        return []

    def is_annotated(self) -> bool:
        return any(fmt == "genbank" for fmt, _ in self._sub_readers)

    @property
    def annotated_chromosomes(self) -> list[str]:
        """Return chromosome names that carry annotation features (GenBank)."""
        result = []
        for fmt, reader in self._sub_readers:
            if fmt == "genbank":
                result.extend(c["name"] for c in reader.chromosomes)
        return result

    @property
    def feature_types(self) -> list[str]:
        """Return sorted list of all feature types across all annotated sub-readers."""
        types: set[str] = set()
        for fmt, reader in self._sub_readers:
            if fmt == "genbank":
                types.update(reader.feature_types)
        return sorted(types)
