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
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, NamedTuple, Optional


class ChromMap(NamedTuple):
    """How one track's contigs line up with the loaded genome's chromosomes."""
    names: dict[str, str]     # genome chromosome -> track contig of the same name
    aliases: dict[str, str]   # genome chromosome -> differently named contig of the same length


def _norm_name(name: str) -> str:
    """A contig name with a leading 'chr' and letter case ignored."""
    n = name[3:] if name[:3].lower() == "chr" else name
    return n.lower()


def _accession_base(name: str) -> str:
    """A contig name without a trailing '.version' (CP124550.1 -> CP124550)."""
    return name.rsplit(".", 1)[0] if "." in name else name


def _match_chromosomes(genome_chroms: list[dict], track_chroms: list[dict],
                       sources: Optional[dict[str, int]] = None) -> ChromMap:
    """Line a track's contigs up with the genome's chromosomes, in one pass
    over each list.

    By name first, with the rules BamReader._resolve_chrom uses: the exact
    name, else the first contig equal ignoring a leading 'chr' and case, else
    the contig equal ignoring a trailing '.version' (CP124550 -> CP124550.1,
    NZ_X.1 -> NZ_X.2). That last rule applies only when the name without its
    last '.suffix' is unique among the track's contigs and among the genome's
    chromosomes: in names like supercont1.15, <contig>.<chunk> or bin.3.7 the
    suffix is an index that many contigs share the rest with, and the rule
    used to draw supercont1.1's data on every supercontig the track lacks.

    Then exact-length aliases for the rest, e.g. a GenBank genome whose LOCUS
    name differs from the accession (CP124550.1) its BigWigs and BAMs were
    aligned to. Genome chromosome G maps to track contig T of the same length
    only when:
      (a) the length is unique among the genome's chromosomes and among the
          track's contigs;
      (b) G has no name match, and T is not the name match of any other
          chromosome;
      (c) the aliases explain the track rather than coincide with it. This is
          judged for each genome source file on its own (``sources`` maps a
          chromosome to its file: the primary genome file, or one merged in
          by add_chromosomes; without it the genome is one file): the aliases
          of a file's chromosomes must cover at least half the length of that
          file's chromosomes without a name match, or at least half that of
          the track's unmatched contigs. Two unrelated draft assemblies of a
          few hundred contigs each share some exact contig length more often
          than not, but such coincidences cover a small fraction of either
          side. A file whose aliases fail (c) loses them and the other files
          keep theirs, so merging an unrelated assembly (e.g. a host draft)
          into the genome cannot cancel the alias that explains the file it
          was merged into.
    """
    genome: dict[str, int] = {}
    for c in genome_chroms:
        genome.setdefault(c["name"], int(c.get("length") or 0))
    track: dict[str, int] = {}
    for c in track_chroms:
        track.setdefault(c["name"], int(c.get("length") or 0))

    by_norm: dict[str, str] = {}
    for t in track:                                  # header order: first match wins
        by_norm.setdefault(_norm_name(t), t)
    t_base = {t: _accession_base(t) for t in track}
    t_base_count = Counter(t_base.values())
    by_base = {b: t for t, b in t_base.items() if t_base_count[b] == 1}
    g_base_count = Counter(_accession_base(g) for g in genome)
    names: dict[str, str] = {}
    for g in genome:
        t = g if g in track else by_norm.get(_norm_name(g))
        if t is None and g_base_count[_accession_base(g)] == 1:
            t = by_base.get(_accession_base(g))
        if t is not None:
            names[g] = t

    claimed = set(names.values())
    g_count, t_count = Counter(genome.values()), Counter(track.values())
    t_by_len = {length: t for t, length in track.items() if t_count[length] == 1}
    aliases: dict[str, str] = {}
    for g, length in genome.items():
        if g in names or length <= 0 or g_count[length] != 1:
            continue
        t = t_by_len.get(length)
        if t is not None and t not in claimed:
            aliases[g] = t
    if aliases:
        src = sources or {}
        aliased: Counter = Counter()                 # per file; the same length on both sides
        g_open: Counter = Counter()                  # per file
        for g, length in genome.items():
            if g in aliases:
                aliased[src.get(g)] += length
            if g not in names:
                g_open[src.get(g)] += length
        t_open = sum(length for t, length in track.items() if t not in claimed)
        weak = {f for f, a in aliased.items() if 2 * a < g_open[f] and 2 * a < t_open}
        if weak:
            aliases = {g: t for g, t in aliases.items() if src.get(g) not in weak}
    return ChromMap(names, aliases)


class AppState:
    def __init__(self):
        self.genome = None                  # GenomeReader instance
        self.tracks: dict[str, dict] = {}   # track_id -> TrackInfo dict
        self.readers: dict[str, Any] = {}   # track_id -> reader instance
        self._track_locks: dict[str, threading.Lock] = {}  # track_id -> Lock
        self._genome_lock = threading.Lock()
        # Guards mutations to the dicts above (load_track / remove_track)
        self._state_lock = threading.Lock()
        # Data-request generations, per key: the track id for coverage/reads
        # requests, one key per track and slot for /stats. Each request bumps
        # its key's, so a long-running read scan can notice it has been
        # superseded (the client aborted it on pan/zoom) and stop early instead
        # of holding the track lock while newer requests queue behind it.
        self._request_gen: dict[str, int] = {}
        # Bumped whenever the genome is replaced or extended; per-track
        # ChromMaps computed against an older version are recomputed.
        self._genome_version = 0
        self._chrom_maps: dict[str, tuple[int, Optional[ChromMap]]] = {}
        # The target chromosomes each data track was last given (by its load
        # or by add-chromosomes), i.e. where the client shows it: a merge
        # starts from these. Forgotten when the genome is replaced.
        self._targets: dict[str, list[str]] = {}
        self._targets_version: dict[str, int] = {}   # the genome_version each was recorded under

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

    @property
    def genome_version(self) -> int:
        """Bumped whenever the genome is replaced or extended (remember_targets,
        merge_snapshot)."""
        return self._genome_version

    def next_request(self, key: str) -> int:
        """Register a new data request under ``key`` and return its generation.
        Coverage/read requests use their track id; /stats requests use one key
        per track and slot, so neither kind cancels the other."""
        with self._state_lock:
            gen = self._request_gen.get(key, 0) + 1
            self._request_gen[key] = gen
        return gen

    def is_current(self, key: str, gen: int) -> bool:
        """False once a newer data request under ``key`` has arrived."""
        return self._request_gen.get(key) == gen

    @contextmanager
    def lock_if_current(self, track_id: str, gen: int, poll: float = 0.05,
                        gen_key: Optional[str] = None) -> Iterator[bool]:
        """Take the track lock for data request ``gen``, giving up as soon as a
        newer request arrives under its generation key: the track id, or
        ``gen_key`` for requests registered under a key of their own (/stats).
        Yields True while holding the lock, or False (lock not taken) when the
        request was superseded; the client has already abandoned it, so it
        should not read at all.

        Superseded requests used to wait for the lock one after another, each
        parking a server worker thread meanwhile. Panning at base level over a
        deep BAM queued dozens of them and starved every other endpoint (the
        reference sequence, other tracks) until the backlog drained."""
        lock = self.track_lock(track_id)
        key = track_id if gen_key is None else gen_key
        while not lock.acquire(timeout=poll):
            if not self.is_current(key, gen):
                yield False
                return
        try:
            yield self.is_current(key, gen)
        finally:
            lock.release()

    # ── Chromosome-name mapping between the genome and a track ─────
    _TRUE_LENGTH_FORMATS = ("bam", "bw", "bigwig")   # headers carry real contig lengths
    _MAX_LISTED_ALIASES = 100                        # pairs listed in a compatibility result

    def chrom_map(self, track_id: str) -> Optional[ChromMap]:
        """The track's ChromMap against the loaded genome (see
        _match_chromosomes), or None when its contig names are left to its
        reader: no genome, or a format whose headers carry no true contig
        lengths (WIG and bedGraph report the last data position instead).

        Computed in one pass per track and genome version, then cached: the
        load-time checks and every data request share it."""
        with self._state_lock:
            version, genome = self._genome_version, self.genome
            info, reader = self.tracks.get(track_id), self.readers.get(track_id)
            hit = self._chrom_maps.get(track_id)
        if hit is not None and hit[0] == version:
            return hit[1]
        cmap = None
        if genome is not None and reader is not None and info \
                and info.get("file_format") in self._TRUE_LENGTH_FORMATS:
            try:
                cmap = _match_chromosomes(genome.chromosomes, reader.chromosomes,
                                          genome.chromosome_sources)
            except Exception:
                cmap = None
        with self._state_lock:
            # Not if the genome changed or the track went away meanwhile.
            if version == self._genome_version and self.readers.get(track_id) is reader:
                self._chrom_maps[track_id] = (version, cmap)
        return cmap

    def resolve_track_chrom(self, track_id: str, chrom: str) -> str:
        """Name to ask a track's reader for when the genome shows ``chrom``.

        For BAM and BigWig tracks, the contig the track's ChromMap pairs with
        ``chrom``: by name ('chr' prefix, case and '.version' variants too), or
        by a unique exact length — e.g. a GenBank genome whose LOCUS name
        differs from the accession (CP124550.1) its BigWigs and BAMs were
        aligned to, which otherwise drew those tracks blank. Other readers
        resolve exact / 'chr'-prefix / case / single-sequence matches
        themselves, so ``chrom`` is passed through."""
        cmap = self.chrom_map(track_id)
        if cmap is None:
            return chrom
        name = cmap.names.get(chrom)
        return name if name is not None else cmap.aliases.get(chrom, chrom)

    def _genome_changed(self):
        """Forget what was computed against the previous genome (caller holds
        _state_lock)."""
        self._genome_version += 1
        self._chrom_maps.clear()

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
            self._genome_changed()
            self._targets.clear()
            self._targets_version.clear()
            if self.genome.is_annotated():
                self._add_genome_annotations_track()

    def _add_genome_annotations_track(self):
        """List the genome's GenBank features as the 'genome_annotations'
        track, served by the genome reader (caller holds _state_lock)."""
        track_id = "genome_annotations"
        self.tracks[track_id] = {
            "id": track_id,
            "name": f"{self.genome.name} (annotations)",
            "file_path": self.genome.file_path,
            "track_type": "genome_annotations",
            "file_format": "genbank",
        }
        self.readers[track_id] = None  # served directly from genome reader

    def add_chromosomes(self, file_path: str):
        """Merge another file's chromosomes into the loaded genome."""
        # genome_lock: concurrent /sequence and /features requests can't read
        # mid-mutation while sub-readers are being appended.
        with self._genome_lock:
            self.genome.add_chromosomes_from(file_path)
            with self._state_lock:
                self._genome_changed()
                # A GenBank file merged into a FASTA genome brings features:
                # the client then shows the annotation track, so serve it.
                if self.genome.is_annotated():
                    self._add_genome_annotations_track()

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
        and a human-readable ``message`` when there is a problem. When genome
        chromosomes are paired with differently named track contigs by their
        exact length, ``aliases`` lists the pairs as
        ``[{"genome", "track", "length"}]`` (the first _MAX_LISTED_ALIASES;
        ``aliases_total`` gives the count when there are more).
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
        # The pairs resolve_track_chrom serves: genome chromosome -> track
        # contig by name (exact; for BAM/BigWig also the 'chr' / case /
        # '.version' variants), and for BAM/BigWig by unique exact length.
        cmap = self.chrom_map(track_id)
        if cmap is None:
            matching = {n: n for n in genome_chroms if n in track_chroms}
            aliases = {}
        else:
            matching, aliases = cmap.names, cmap.aliases
        listed = {}
        if aliases:
            # A renamed draft assembly can alias thousands of contigs; list the
            # first few and say how many there are.
            pairs = list(aliases.items())
            listed["aliases"] = [{"genome": g, "track": t, "length": track_chroms.get(t, 0)}
                                 for g, t in pairs[:self._MAX_LISTED_ALIASES]]
            if len(pairs) > self._MAX_LISTED_ALIASES:
                listed["aliases_total"] = len(pairs)

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
            return {"status": "ok", **listed}

        # ── Multi-chromosome: check name overlap (aliases count as matches) ──
        if not matching and not aliases:
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
        for name, t_name in matching.items():
            t_len = track_chroms.get(t_name, 0)
            g_len = genome_chroms.get(name, 0)
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
                    f"but {track_chroms[matching[ex]]:,} bp in track"
                ),
                "track_chromosomes": list(track_chroms.keys()),
                "genome_chromosomes": list(genome_chroms.keys()),
                **listed,
            }

        return {"status": "ok", **listed}

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

        # Multi-chrom: name matches (exact; for BAM/BigWig also the 'chr' /
        # case / '.version' variants), plus unique exact-length aliases (e.g.
        # LOCUS name vs accession) — the pairs resolve_track_chrom serves.
        cmap = self.chrom_map(track_id)
        if cmap is None:
            matched = [n for n in all_names if n in track_names]
        else:
            matched = [n for n in all_names if n in cmap.names or n in cmap.aliases]
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

    # ── Target chromosomes across add_chromosomes ────────────────
    def remember_targets(self, track_id: str, targets: list,
                         version: Optional[int] = None) -> bool:
        """Record the target chromosomes a data track was given (by its load or
        by add-chromosomes), i.e. where the client shows it. A merge starts
        from them (merged_target_chromosomes). With ``version``, the
        genome_version they were computed against, they are recorded only if
        the genome has not changed since; False asks the caller to compute
        them again (a track load that a merge overtook)."""
        with self._state_lock:
            if version is not None and version != self._genome_version:
                return False
            if track_id in self.tracks:
                self._targets[track_id] = list(targets)
                self._targets_version[track_id] = self._genome_version
            return True

    def remembered_targets(self) -> dict:
        """By data track id, the target chromosomes it was given since the
        genome was loaded and the genome_version they were recorded under."""
        with self._state_lock:
            return {t: (list(s), self._targets_version.get(t))
                    for t, s in self._targets.items() if t in self.tracks}

    def merge_snapshot(self) -> tuple:
        """What merged_target_chromosomes needs from before a merge: the
        genome's chromosome names, per data track (by id) the chromosomes it
        is shown on and those its ChromMap pairs (None when it has no map),
        the ids of the tracks given targets so far, and the genome_version.
        A track given no targets since the genome was replaced (loaded
        against the previous one) is left out: where the client shows it is
        unknown."""
        if self.genome is None:
            return set(), {}, set(), self._genome_version
        old_names = {c["name"] for c in self.genome.chromosomes}
        with self._state_lock:
            version = self._genome_version
            given = {t: list(s) for t, s in self._targets.items() if t in self.tracks}
        per_track = {}
        for track_id, shown in given.items():
            try:
                cmap = self.chrom_map(track_id)
            except Exception:
                continue
            per_track[track_id] = (shown, None if cmap is None else set(cmap.names) | set(cmap.aliases))
        return old_names, per_track, set(given), version

    def merged_target_chromosomes(self, track_id: str, shown: list, old_names: set,
                                  mapped_before: Optional[set]) -> list:
        """A data track's target chromosomes once add_chromosomes has extended
        the genome, from those it was shown on before (``shown``; the genome's
        names then, ``old_names``, and the ones its ChromMap paired,
        ``mapped_before``, from merge_snapshot):
          - a BAM or BigWig track whose ChromMap pairs some chromosome (by name,
            or by a unique exact length) goes exactly there: that is where its
            data is served now, e.g. by name on an added accession instead of by
            length on a GenBank LOCUS name that the merge made ambiguous;
          - any other track keeps ``shown``, less the chromosomes it had only
            through its ChromMap (pairs the merge cancelled, where its data is
            no longer served), plus the added chromosomes named like one of its
            contigs.
        Never the fallbacks of get_target_chromosomes (the closest length
        within 5%, every chromosome), which are for a track loaded against a
        genome it does not match: a single-contig track's reader serves its
        contig under any name, so after a merge they would draw it on an added
        chromosome of another organism."""
        if self.genome is None:
            return []
        names = [c["name"] for c in self.genome.chromosomes]
        cmap = self.chrom_map(track_id)
        if cmap is not None:
            paired = [n for n in names if n in cmap.names or n in cmap.aliases]
            if paired:
                return paired
        keep = set(shown) - (mapped_before or set())
        reader = self.readers.get(track_id)
        try:
            contigs = {c["name"] for c in reader.chromosomes} if reader is not None else set()
        except Exception:
            contigs = set()
        return [n for n in names if n in keep or (n not in old_names and n in contigs)]

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
        with self._state_lock:
            self._chrom_maps.pop(track_id, None)
            self._targets.pop(track_id, None)
            self._targets_version.pop(track_id, None)
            for key in [k for k in self._request_gen if k == track_id or k.startswith(track_id + "|")]:
                del self._request_gen[key]


app_state = AppState()
