"""
Genome reader — supports FASTA (via pyfaidx) and GenBank (via BioPython).
Auto-detects format from file extension.  Supports merging chromosomes from
multiple files via add_chromosomes_from().
"""

from pathlib import Path


class GenomeReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        # One per file: the primary file, then each add_chromosomes_from file.
        self._sub_readers: list[tuple] = []  # [(format, reader), ...]
        self._chrom_index: dict[str, int] = {}  # chrom name → index in _sub_readers
        self._add_file(file_path)

    @staticmethod
    def _detect_format(file_path: str) -> str:
        ext = Path(file_path).suffix.lower()
        return "genbank" if ext in (".gb", ".gbk", ".genbank") else "fasta"

    @staticmethod
    def _close(reader):
        close = getattr(reader, "close", None)
        if close is not None:
            try:
                close()
            except Exception:
                pass

    def _add_file(self, file_path: str):
        fmt = self._detect_format(file_path)
        if fmt == "genbank":
            from readers.genbank_reader import GenBankReader
            reader = GenBankReader(file_path)
            names = [info["name"] for info in reader.chromosomes]
        else:
            from pyfaidx import Fasta
            reader = Fasta(file_path)
            names = list(reader.keys())
        label = Path(file_path).name
        if not names:
            # e.g. a FASTA file named .gb, whose GenBank parse finds nothing
            self._close(reader)
            raise ValueError(f"No sequences found in {label}"
                             + (": is it a GenBank file?" if fmt == "genbank" else ""))
        if self._sub_readers and all(n in self._chrom_index for n in names):
            # A merged file that adds nothing, e.g. the same file twice.
            self._close(reader)
            raise ValueError(f"No new chromosomes in {label}: every sequence "
                             "name in it is already in the genome")
        idx = len(self._sub_readers)
        self._sub_readers.append((fmt, reader))
        # Build explicit chromosome→reader index
        # Skip duplicates: first file's chromosome takes precedence
        for name in names:
            if name not in self._chrom_index:
                self._chrom_index[name] = idx

    def add_chromosomes_from(self, file_path: str):
        """Load another file and merge its chromosomes into this genome. Names
        already in the genome stay with the file they came from; a file that
        adds none, or has no sequences, raises ValueError."""
        self._add_file(file_path)

    def _served(self, idx: int, reader) -> list[str]:
        """The names of the GenBank sub-reader ``idx``'s records that the
        genome serves from it: not those an earlier file holds."""
        return [c["name"] for c in reader.chromosomes if self._chrom_index.get(c["name"]) == idx]

    @property
    def name(self) -> str:
        return Path(self.file_path).stem

    @property
    def chromosome_sources(self) -> dict[str, int]:
        """The file each chromosome came from: 0 for the primary file, then
        1, 2, ... for the add_chromosomes_from files in the order added. A
        name found in several files belongs to the first, whose sequence is
        the one served."""
        return dict(self._chrom_index)

    @property
    def chromosomes(self) -> list[dict]:
        """Each chromosome once, in file order. A name found in several files
        is listed from the first, whose sequence is the one served."""
        result, seen = [], set()
        for idx, (fmt, reader) in enumerate(self._sub_readers):
            if fmt == "genbank":
                infos = reader.chromosomes
            else:
                infos = [{"name": k, "length": len(reader[k])} for k in reader.keys()]
            for info in infos:
                if info["name"] not in seen and self._chrom_index.get(info["name"]) == idx:
                    seen.add(info["name"])
                    result.append(info)
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
        for idx, (fmt, reader) in enumerate(self._sub_readers):
            if fmt == "genbank":
                result.extend(self._served(idx, reader))
        return list(dict.fromkeys(result))

    @property
    def feature_types(self) -> list[str]:
        """Sorted feature types of the GenBank records the genome serves."""
        types: set[str] = set()
        for idx, (fmt, reader) in enumerate(self._sub_readers):
            if fmt == "genbank":
                types.update(reader.feature_types_of(self._served(idx, reader)))
        return sorted(types)

    def search_features(self, q_lower: str, limit: int = 50) -> list[dict]:
        """Search the annotations of the GenBank records the genome serves for
        a gene/feature."""
        results = []
        for idx, (fmt, reader) in enumerate(self._sub_readers):
            if fmt == "genbank" and hasattr(reader, "search_features"):
                results.extend(reader.search_features(q_lower, limit, set(self._served(idx, reader))))
        results.sort(key=lambda r: (-r["relevance"], r["start"]))
        return results[:limit]
