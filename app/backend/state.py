"""
Global application state — holds the loaded genome and track readers.
Single-process in-memory store; safe for a local desktop app.

FastAPI runs sync route handlers in a thread pool, so multiple concurrent
requests can hit the same reader simultaneously. Several backing libraries
we use (bamnostic, pyfaidx, pyBigWig) are NOT thread-safe — concurrent
calls on the same instance can corrupt internal file-handle state and
raise spurious errors under load (e.g. rapid zoom/pan). We guard each
reader with its own ``threading.Lock`` and expose them via
``track_lock(track_id)`` / ``genome_lock``.
"""

import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class AppState:
    def __init__(self):
        self.genome = None                  # GenomeReader instance
        self.tracks: dict[str, dict] = {}   # track_id -> TrackInfo dict
        self.readers: dict[str, Any] = {}   # track_id -> reader instance
        self._track_locks: dict[str, threading.Lock] = {}  # track_id -> Lock
        self._genome_lock = threading.Lock()
        # Guards mutations to the dicts above (load_track / remove_track)
        self._state_lock = threading.Lock()
        # Per-track data-request generation: each coverage/reads request bumps
        # it, so a long-running read scan can notice it has been superseded
        # (the client aborted it on pan/zoom) and stop early instead of holding
        # the track lock while newer requests queue behind it.
        self._request_gen: dict[str, int] = {}
        self._chrom_alias_cache: dict[tuple, str] = {}

    # ── Thread-safety helpers ────────────────────────────────────
    def track_lock(self, track_id: str) -> threading.Lock:
        """Return the per-track read lock, creating one on first use."""
        lock = self._track_locks.get(track_id)
        if lock is None:
            with self._state_lock:
                lock = self._track_locks.get(track_id)
                if lock is None:
                    lock = threading.Lock()
                    self._track_locks[track_id] = lock
        return lock

    @property
    def genome_lock(self) -> threading.Lock:
        return self._genome_lock

    def next_request(self, track_id: str) -> int:
        """Register a new data request for a track; returns its generation."""
        with self._state_lock:
            gen = self._request_gen.get(track_id, 0) + 1
            self._request_gen[track_id] = gen
        return gen

    def is_current(self, track_id: str, gen: int) -> bool:
        """False once a newer data request for the track has arrived."""
        return self._request_gen.get(track_id) == gen

    @contextmanager
    def lock_if_current(self, track_id: str, gen: int, poll: float = 0.05) -> Iterator[bool]:
        """Take the track lock for data request ``gen``, giving up as soon as a
        newer request for the track arrives. Yields True while holding the
        lock, or False (lock not taken) when the request was superseded; the
        client has already abandoned it, so it should not read at all.

        Superseded requests used to wait for the lock one after another, each
        parking a server worker thread meanwhile. Panning at base level over a
        deep BAM queued dozens of them and starved every other endpoint (the
        reference sequence, other tracks) until the backlog drained."""
        lock = self.track_lock(track_id)
        while not lock.acquire(timeout=poll):
            if not self.is_current(track_id, gen):
                yield False
                return
        try:
            yield self.is_current(track_id, gen)
        finally:
            lock.release()

    # ── Chromosome-name mapping between the genome and a track ─────
    _TRUE_LENGTH_FORMATS = ("bam", "bw", "bigwig")   # headers carry real contig lengths

    def _length_alias(self, track_id: str, chrom: str):
        """The track contig whose length EXACTLY equals genome chromosome
        ``chrom``'s, when that length is unique among both the genome's
        chromosomes and the track's contigs; else None. Only for formats whose
        headers carry true lengths — other readers report the last data
        position as a length."""
        if self.genome is None:
            return None
        info = self.tracks.get(track_id, {})
        reader = self.readers.get(track_id)
        if reader is None or info.get("file_format") not in self._TRUE_LENGTH_FORMATS:
            return None
        try:
            contigs = {c["name"]: c.get("length", 0) for c in reader.chromosomes}
            genome_chroms = self.genome.chromosomes
        except Exception:
            return None
        g_len = next((c["length"] for c in genome_chroms if c["name"] == chrom), 0)
        if not g_len:
            return None
        same = [n for n, length in contigs.items() if length == g_len]
        g_same = [c for c in genome_chroms if c["length"] == g_len]
        return same[0] if len(same) == 1 and len(g_same) == 1 else None

    def resolve_track_chrom(self, track_id: str, chrom: str) -> str:
        """Name to ask a track's reader for when the genome shows ``chrom``.

        Readers resolve exact / 'chr'-prefix / case / single-sequence matches
        themselves. This adds the case they cannot see: a differently named
        contig of exactly the same, unique length — e.g. a GenBank genome whose
        LOCUS name differs from the accession (CP124550.1) its BigWigs and BAMs
        were aligned to, which otherwise drew those tracks blank."""
        g = self.genome
        key = (track_id, chrom, id(g), len(g.chromosomes) if g is not None else 0)
        hit = self._chrom_alias_cache.get(key)
        if hit is not None:
            return hit
        result = chrom
        reader = self.readers.get(track_id)
        try:
            names = {c["name"] for c in reader.chromosomes} if reader is not None else set()
        except Exception:
            names = set()
        if names and chrom not in names:
            resolved = reader._resolve_chrom(chrom) if hasattr(reader, "_resolve_chrom") else chrom
            if resolved not in names:
                result = self._length_alias(track_id, chrom) or chrom
        self._chrom_alias_cache[key] = result
        return result

    def load_genome(self, file_path: str):
        from readers.genome_reader import GenomeReader
        # Build the new reader OUTSIDE the lock — construction can be slow
        # for large GenBank files and we don't want to block in-flight
        # /api/genome/sequence calls (which acquire genome_lock).
        new_genome = GenomeReader(file_path)
        # Atomic swap: hold genome_lock so concurrent get_sequence /
        # get_features readers see either the old or fully-built new reader,
        # never a half-initialised one. Hold _state_lock for tracks/readers
        # mutation so /api/tracks/load racing against this can't observe
        # a torn dict.
        with self._genome_lock, self._state_lock:
            self.genome = new_genome
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

    def load_track(self, file_path: str, name: str, index_path: str = None) -> dict:
        # Detect compound extensions (.vcf.gz / .wig.gz / .bedgraph.gz / .bdg.gz)
        # — Path.suffix only returns the last segment ('.gz') so a naive
        # check rejects every gzip-compressed track even though every
        # downstream reader handles them transparently.
        name_lower = file_path.lower()
        ext = None
        for compound in (".vcf.gz", ".wig.gz", ".bedgraph.gz", ".bdg.gz"):
            if name_lower.endswith(compound):
                ext = compound
                break
        if ext is None:
            ext = Path(file_path).suffix.lower()
        track_id = str(uuid.uuid4())[:8]

        if ext == ".bam":
            from readers.bam_reader import BamReader
            reader = BamReader(file_path, index_path=index_path)
            track_type = "reads"
            file_format = "bam"

        elif ext in (".cram", ".sam"):
            # bamnostic only reads BGZF-compressed BAM. Reject CRAM/SAM with a
            # clear, actionable message instead of routing them to BamReader,
            # which would fail with a cryptic low-level decode error (and, for
            # CRAM, demand a .bai when the real index is .crai).
            fmt = ext.lstrip(".").upper()
            raise ValueError(
                f"{fmt} alignments are not supported. Convert to a sorted, "
                f"indexed BAM first:  samtools view -b in{ext} | "
                f"samtools sort -o out.bam  &&  samtools index out.bam"
            )

        elif ext in (".bw", ".bigwig", ".bedgraph", ".bdg", ".wig",
                     ".wig.gz", ".bedgraph.gz", ".bdg.gz"):
            from readers.bigwig_reader import make_coverage_reader
            reader = make_coverage_reader(file_path)
            track_type = "coverage"
            # Display the underlying format, not ".gz"
            file_format = ext.lstrip(".").replace(".gz", "")

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
            # True when this annotation track carries enrichment-ranked peaks,
            # so the frontend can overlay rank labels on coverage tracks.
            "has_ranks": bool(getattr(reader, "has_ranks", False)),
        }
        # Atomic write: keep tracks[] and readers[] consistent so a
        # concurrent fetch can't observe a track that exists in self.tracks
        # but is missing from self.readers (or vice-versa).
        with self._state_lock:
            self.tracks[track_id] = info
            self.readers[track_id] = reader
        return info

    def search(self, query: str, limit: int = 50) -> list:
        """Search the loaded genome's annotations and all annotation/peak
        tracks for features matching `query` (gene name, locus_tag, product,
        feature name). Returns ranked, de-duplicated result dicts."""
        q = (query or "").strip().lower()
        if not q:
            return []
        results = []

        if self.genome is not None and hasattr(self.genome, "search_features"):
            with self._genome_lock:
                try:
                    for r in self.genome.search_features(q, limit):
                        r = dict(r)
                        r.setdefault("source", "genome")
                        results.append(r)
                except Exception:
                    pass

        for tid, reader in list(self.readers.items()):
            if reader is None or not hasattr(reader, "search_features"):
                continue
            track = self.tracks.get(tid, {})
            with self.track_lock(tid):
                try:
                    track_results = reader.search_features(q, limit)
                except Exception:
                    track_results = []
            for r in track_results:
                r = dict(r)
                r["source"] = track.get("name", "track")
                r["track_id"] = tid
                results.append(r)

        # Sort by relevance then position, de-dup by location+name.
        seen = set()
        deduped = []
        for r in sorted(results, key=lambda r: (-r.get("relevance", 0), r.get("start", 0))):
            key = (r.get("chrom"), r.get("start"), r.get("end"), r.get("name"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(r)
        return deduped[:limit]

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

        # ── Multi-chromosome: check name overlap (unique exact-length aliases
        # count as matches — see resolve_track_chrom) ──
        if not matching_names and not any(self._length_alias(track_id, g) for g in genome_chroms):
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

        # Multi-chrom: exact name matches, plus unique exact-length aliases
        # (e.g. LOCUS name vs accession — see resolve_track_chrom)
        matched = [gc["name"] for gc in genome_chroms
                   if gc["name"] in track_names or self._length_alias(track_id, gc["name"])]
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
        # Hold the per-track lock during close so we don't close while
        # an in-flight request is mid-read.
        lock = self._track_locks.pop(track_id, None)
        if lock is not None:
            with lock:
                reader = self.readers.pop(track_id, None)
                if reader and hasattr(reader, "close"):
                    try:
                        reader.close()
                    except Exception:
                        pass
        else:
            reader = self.readers.pop(track_id, None)
            if reader and hasattr(reader, "close"):
                try:
                    reader.close()
                except Exception:
                    pass
        self.tracks.pop(track_id, None)


app_state = AppState()
