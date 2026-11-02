"""
BAM reader — uses bamnostic (pure Python, Windows-compatible).
Requires a .bai index alongside the BAM file for random-access queries.
CRAM and SAM are not supported by bamnostic; convert to an indexed BAM.

Coverage comes from a BamCoverageIndex (exact per-base depth, built once in
the background); individual reads for the zoomed-in view come from a raw
scan of the .bai chunks (readers/bam_records.py). bamnostic reads the header
and serves the live coverage fallback.
"""

import zlib
from pathlib import Path
from typing import Optional

import bamnostic as bam

from readers.bam_coverage import BamCoverageIndex, SKIP_FLAGS
from readers.bam_records import BamRecords, decode_record

MAX_READS_RETURNED = 5000
# Bound on the records (of any kind) one read-view request examines: about a
# second of scanning, four times what the deepest 50 kb view of a ~400 MB ChIP
# BAM needs.
MAX_READS_SCANNED = 1_000_000
MAX_COVERAGE_READS = 500_000   # cap for the live fallback pileup (index unavailable)
READ_DETAIL_THRESHOLD = 50_000  # bp
# Reads hidden in the pileup, matching IGV's defaults and the coverage index.
READ_VIEW_SKIP_FLAGS = 0x200 | 0x400   # QC-fail | duplicate
# The live coverage fallback fetches through bamnostic, whose fetch() decides
# overlap from pos + len(SEQ) instead of the reference span; it fetches from
# this far left of the range so reads that start before it are still counted.
DEFAULT_READ_LOOKBACK = 2_000

# Standard index naming conventions: file.bam.bai and file.bai
_INDEX_SUFFIXES = (".bam.bai", ".bai")

# A valid .bai begins with the 4-byte magic "BAI\1" and a non-trivial body.
_BAI_MAGIC = b"BAI\x01"
_MIN_BAI_SIZE = 8  # magic (4) + n_ref (4) at the very least


def _valid_bai(path: Path) -> bool:
    """Return True only if `path` looks like a real, non-empty .bai index.

    Catches the empty/zero-byte and wrong-format cases that would otherwise
    surface as a cryptic ``struct.error: unpack requires a buffer of 8 bytes``
    or ``AssertionError: Wrong BAI magic header`` from deep inside bamnostic.
    """
    try:
        if path.stat().st_size < _MIN_BAI_SIZE:
            return False
        with path.open("rb") as f:
            return f.read(4) == _BAI_MAGIC
    except OSError:
        return False


def _find_index(bam_path: str, index_path: Optional[str] = None) -> Optional[str]:
    """Locate a usable .bai index for the given BAM file.

    If ``index_path`` is supplied (e.g. the user pointed at a .bai that lives
    in a different directory), it takes precedence when it exists and is a
    valid index. Otherwise both standard naming conventions (file.bam.bai and
    file.bai) are checked in the BAM's own directory. Only indexes that pass
    the magic/size sanity check are returned.
    """
    if index_path:
        ip = Path(index_path).expanduser()
        if ip.exists() and _valid_bai(ip):
            return str(ip.resolve())
        # An explicit-but-bad index path is a hard error so the user learns
        # their index is empty/corrupt rather than silently falling back.
        if ip.exists():
            raise ValueError(
                f"The supplied index '{ip.name}' is not a valid .bai file "
                f"(empty or wrong format). Rebuild it with: samtools index <file>.bam"
            )

    p = Path(bam_path)
    for candidate in (
        p.parent / (p.name + ".bai"),   # reads.bam.bai
        p.with_suffix(".bai"),           # reads.bai
    ):
        if candidate.exists() and _valid_bai(candidate):
            return str(candidate)
    return None


def _fetch_error_msg(file_path: str) -> str:
    return (
        f"Failed reading alignments from '{Path(file_path).name}' — the BAM or "
        f"its index appears to be corrupt or truncated. Re-create it with "
        f"samtools (samtools sort, then samtools index)."
    )


def _parse_cigar(cigar_string: str) -> list[tuple[int, str]]:
    """Parse a CIGAR string into a list of (length, op) tuples."""
    ops = []
    num = ""
    for ch in cigar_string:
        if ch.isdigit():
            num += ch
        else:
            if num:
                ops.append((int(num), ch))
            num = ""
    return ops


def _norm_chrom(name: str) -> str:
    """Normalise a contig name for comparison: strip a *leading* 'chr' prefix
    only (not internal occurrences) and lowercase. So 'chr1'/'1' match but
    'achrb' is not mangled to 'ab'."""
    n = name[3:] if name[:3].lower() == "chr" else name
    return n.lower()


class BamReader:
    def __init__(self, file_path: str, index_path: Optional[str] = None):
        self.file_path = file_path

        # Validate BAM file exists
        if not Path(file_path).exists():
            raise FileNotFoundError(f"BAM file not found: {file_path}")

        # Resolve (and validate) the index before opening.
        resolved_index = _find_index(file_path, index_path)
        if resolved_index is None:
            bam_name = Path(file_path).name
            raise FileNotFoundError(
                f"BAM index (.bai) not found for '{bam_name}'. "
                f"A BAM must be sorted and indexed. Create one with: "
                f"samtools index '{bam_name}'  "
                f"(expected '{bam_name}.bai' or '{Path(bam_name).stem}.bai' "
                f"beside the BAM, or supply its path explicitly)."
            )
        # The read view scans the .bai (parsed on first use) and the BAM itself.
        self._records = BamRecords(file_path, resolved_index)

        # Open tolerantly (ignore a missing EOF marker — common for BAMs
        # copied/streamed without the trailing block) and convert any
        # low-level decode failure into an actionable message instead of a
        # raw 'Malformed BGZF block' / 'Wrong BAI magic header' traceback.
        try:
            self._aln = bam.AlignmentFile(
                file_path, "rb",
                index_filename=resolved_index,
                ignore_truncation=True,
            )
        except Exception as e:
            msg = str(e).lower()
            if "bai" in msg or "index" in msg or "magic" in msg:
                raise ValueError(
                    f"The BAM index for '{Path(file_path).name}' is corrupt or "
                    f"incompatible. Rebuild it with: samtools index "
                    f"'{Path(file_path).name}'"
                ) from e
            raise ValueError(
                f"'{Path(file_path).name}' could not be read as a BAM file — it "
                f"may be corrupt, truncated, or not a BAM. Re-create it with "
                f"samtools (sort, then index)."
            ) from e

        # A BAM with no reference sequences can't be queried meaningfully.
        if not self.chromosomes:
            raise ValueError(
                f"'{Path(file_path).name}' has no reference sequences in its "
                f"header — it cannot be displayed. Ensure the BAM was aligned "
                f"to a reference and retains its @SQ header."
            )

        # Exact coverage is built in the background from a separate file handle
        # (bamnostic's handle stays free for read queries).
        self._cov = BamCoverageIndex(file_path)

    def close(self):
        self._cov.cancel()
        try:
            self._aln.close()
        except Exception:
            pass

    def coverage_status(self) -> dict:
        return self._cov.status()

    def has_negative(self, chrom: str) -> bool:
        return False   # read depth is never negative

    def _contig_length(self, chrom: str) -> int:
        for c in self.chromosomes:
            if c["name"] == chrom:
                return c["length"]
        return 0

    @property
    def chromosomes(self) -> list[dict]:
        """Reference contigs as [{name, length}].

        The BAM header is immutable once opened, so the contig list is computed
        once and cached — it is read on every ``_resolve_chrom`` (i.e. every
        coverage/read fetch), and rebuilding it per request was wasted work on
        many-contig BAMs.
        """
        cached = getattr(self, "_chrom_cache", None)
        if cached is not None:
            return cached
        result = self._read_chromosomes()
        self._chrom_cache = result
        return result

    def _read_chromosomes(self) -> list[dict]:
        """Compute the contig list from bamnostic's authoritative binary
        reference block via the pysam-compatible ``references``/``lengths``
        tuples (always present, regardless of whether the BAM carries an @SQ SAM
        *text* header). The previous implementation used ``header.get('SQ')``
        which raises ``AttributeError`` on bamnostic's ``BAMheader`` object (it
        is not a dict) — i.e. it broke for *every* BAM. Falls back to the raw
        refs map, then to a dict-style header, for resilience across versions.
        """
        aln = self._aln
        refs = getattr(aln, "references", None)
        lengths = getattr(aln, "lengths", None)
        if refs and lengths and len(refs) == len(lengths):
            return [{"name": n, "length": int(l)} for n, l in zip(refs, lengths)]

        # Fallback 1: bamnostic's binary header refs map {tid: (name, length)}
        header = getattr(aln, "header", None)
        refs_map = getattr(header, "refs", None)
        if isinstance(refs_map, dict) and refs_map:
            return [
                {"name": v[0], "length": int(v[1])}
                for _, v in sorted(refs_map.items())
            ]

        # Fallback 2: dict-style header (older/other bamnostic builds)
        if hasattr(header, "get"):
            sq = header.get("SQ", []) or []
            return [{"name": s["SN"], "length": int(s["LN"])} for s in sq]

        return []

    def _resolve_chrom(self, chrom: str) -> str:
        """Map a requested chromosome name to one the BAM actually has.

        Matches exact names first, then with/without a leading 'chr', then
        case-insensitively, then by accession base (strip a trailing
        '.version'). Returns the original name unchanged when nothing matches
        (bamnostic.fetch then raises KeyError, which the callers turn into an
        empty result) — it NEVER silently remaps to a different contig, which
        previously made single-contig BAMs serve the wrong data under any
        requested name.
        """
        names = [c["name"] for c in self.chromosomes]
        if chrom in names:
            return chrom

        target = _norm_chrom(chrom)
        for name in names:
            if _norm_chrom(name) == target:
                return name

        chrom_base = chrom.rsplit(".", 1)[0] if "." in chrom else chrom
        for name in names:
            name_base = name.rsplit(".", 1)[0] if "." in name else name
            if name_base == chrom_base:
                return name
        return chrom

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> dict:
        """Binned read depth over [start, end): exact mean / max / min per bin.

        Served from the background coverage index; bins the index has not
        reached yet come back ``pending``. If the index is unavailable (very
        large reference, or the scan failed) a bounded live pileup is used
        instead and the result is flagged ``truncated`` when its read cap was
        hit — never silently drawn as zero coverage."""
        chrom = self._resolve_chrom(chrom)
        if end - start <= 0:
            return {"bins": [], "meta": {}}
        state = self._cov.state
        if state in ("building", "ready"):
            if not self._cov.has_contig(chrom):
                return {"bins": [], "meta": {"coverage_state": state}}   # contig not in this BAM
            bins_data = self._cov.coverage(chrom, start, end, bins)
            if bins_data:
                return {"bins": bins_data, "meta": {
                    "coverage_state": self._cov.state,
                    "coverage_progress": self._cov.progress,
                }}
        # Index unavailable (reference too large for it, or the scan failed).
        bins_data, truncated = self._live_coverage(chrom, start, end, bins)
        return {"bins": bins_data, "meta": {
            "coverage_state": self._cov.state,
            "coverage_error": self._cov.error,
            "truncated": truncated,
        }}

    def _live_coverage(self, chrom, start, end, bins):
        """Fallback pileup when the coverage index is unavailable: exact mean,
        max and min depth of aligned bases per bin (the index's counting
        rules), bounded by MAX_COVERAGE_READS.

        Reads are taken in file order from the BAI linear-index offset for
        the range start, and how far a read reaches comes from its CIGAR.
        (bamnostic's fetch() looks that offset up through the bins, which
        finds nothing when the 16 kb window at the range start has no reads,
        and judges overlap by the sequence length, which drops reads that
        start left of the range and span more reference than their sequence:
        long reads with large deletions or introns.) Aligned blocks become
        depth-change events in a heap. No read starts left of the previous
        one, so all depth left of the newest start is final and the sweep
        folds it into the bins; memory follows the depth, not the length of
        the range. Records out of coordinate order raise (a stale index), a
        contig without index intervals has zero depth, and bins beyond the
        read cap are flagged ``pending`` rather than reported as zero.
        Returns (bins, truncated)."""
        from heapq import heappop, heappush

        L = self._contig_length(chrom)
        region_len = end - start
        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        edges = [start + int(i * bin_size) for i in range(n_bins)] + [end]
        lo, hi = max(0, start), min(end, L)
        sums = [0] * n_bins
        maxs = [0] * n_bins
        mins = [1 << 62] * n_bins
        truncated = False
        complete_to = hi
        events = []                 # heap: pos << 1 | 1 (depth +1 at pos) or pos << 1 (-1)
        cur, depth, k = lo, 0, 0    # [lo, cur) is folded into the bins; depth is that at cur

        def fold(x):
            """Fold the final depth over [cur, x) into the bins."""
            nonlocal cur, depth, k
            while cur < x:
                while events and events[0] >> 1 <= cur:
                    depth += 1 if heappop(events) & 1 else -1
                nxt = events[0] >> 1 if events and events[0] >> 1 < x else x
                while cur < nxt:            # depth is constant over [cur, nxt)
                    b = edges[k + 1]
                    if b <= cur:
                        k += 1
                        continue
                    t = nxt if nxt < b else b
                    sums[k] += depth * (t - cur)
                    if depth > maxs[k]:
                        maxs[k] = depth
                    if depth < mins[k]:
                        mins[k] = depth
                    cur = t

        if hi > lo:
            try:
                tid = self._aln.ref2tid[chrom]
                intervals = self._aln._index.get_ref(tid).intervals
            except KeyError:
                return [], False   # contig absent from this BAM
            except IndexError:
                # bamnostic raises this for a contig without linear-index
                # intervals, i.e. without reads: zero depth, not a corrupt file.
                intervals = ()
            except Exception as e:
                raise RuntimeError(_fetch_error_msg(self.file_path)) from e
            # Per 16 kb window, the linear index holds the offset of the first
            # read reaching into it (an earlier one for a window without reads;
            # 0 before the contig's first read in Picard indexes), so every
            # read overlapping [lo, hi) is at or after this offset.
            voffset = next((v for v in intervals[lo >> 14:] if v), None)
            total = 0
            try:
                if voffset is not None:
                    self._aln.seek(voffset)
                    for read in self._aln:
                        rs = read.reference_start
                        if read.reference_id != tid or rs >= hi:
                            break
                        if read.flag & SKIP_FLAGS or not read.cigartuples:
                            continue
                        x = rs if rs > lo else lo
                        if x < cur:
                            raise ValueError("alignments are not in coordinate order")
                        fold(x)
                        p = rs
                        for op, ln in read.cigartuples:
                            if op == 0 or op == 7 or op == 8:      # M = X: aligned bases
                                a, b = (p if p > lo else lo), (p + ln if p + ln < hi else hi)
                                if b > a:
                                    heappush(events, a << 1 | 1)
                                    heappush(events, b << 1)
                                p += ln
                            elif op == 2 or op == 3:                # D N: skip reference
                                p += ln
                        if p <= lo:
                            continue                # ends before the range
                        total += 1
                        if total >= MAX_COVERAGE_READS:
                            truncated = True
                            complete_to = x
                            break
            except Exception as e:
                # Corrupt index / BGZF decode failure mid-fetch: a clear message
                # (HTTP 503) rather than a track that looks valid but is wrong.
                raise RuntimeError(_fetch_error_msg(self.file_path)) from e
            fold(complete_to)

        out = []
        for i in range(n_bins):
            a, b = edges[i], edges[i + 1]
            d = {"start": a, "end": b}
            ac, bc = max(a, 0), min(b, L)
            if bc <= ac:
                d.update(value=0.0, max=0.0, min=0.0, cov=0)
            elif bc > complete_to:
                d.update(value=0.0, max=0.0, min=0.0, cov=0, pending=True)
            else:
                d.update(value=sums[i] / (bc - ac), max=float(maxs[i]), min=float(mins[i]), cov=bc - ac)
            out.append(d)
        return out, truncated

    def get_reads(self, chrom: str, start: int, end: int, is_current=None) -> dict:
        """Individual read alignments overlapping [start, end), with parsed CIGAR
        operations. Returns {"reads", "truncated", "total", "total_exact"}.

        - Every alignment overlapping the window is found, however far left it
          starts: the .bai chunks that can hold one are scanned directly
          (readers/bam_records.py), and overlap is tested against the true
          reference span — the CIGAR, or the CG tag that holds it for reads
          with more than 65,535 operations.
        - Unmapped, QC-fail and duplicate reads are hidden (IGV defaults);
          secondary and supplementary alignments are shown.
        - ``total`` is the exact number of overlapping reads (a lower bound,
          with ``total_exact`` False, only when MAX_READS_SCANNED records were
          examined before the end of the window). Up to MAX_READS_RETURNED
          reads are all returned; beyond that exactly MAX_READS_RETURNED are
          sampled evenly across the view (see _downsample) and ``truncated``
          says the pileup is a sample.
        - ``is_current`` (optional) is polled while scanning. Once it returns
          False a newer request has superseded this one: the scan stops and the
          result is empty and flagged ``cancelled``, never a partial pileup.
        """
        chrom = self._resolve_chrom(chrom)
        L = self._contig_length(chrom)
        empty = {"reads": [], "truncated": False, "total": 0, "total_exact": True}
        if (L and start >= L) or end <= start:
            return empty
        tid = next((i for i, c in enumerate(self.chromosomes) if c["name"] == chrom), None)
        if tid is None:
            return empty                                  # contig absent from this BAM
        try:
            scan = self._records.scan(
                tid, max(0, start), min(end, L) if L else end,
                skip_flags=0x4 | READ_VIEW_SKIP_FLAGS, is_current=is_current,
                max_records=MAX_READS_SCANNED, keep=MAX_READS_RETURNED)
            total = len(scan.vofs)
            records = None
            if not scan.cancelled:
                if total <= MAX_READS_RETURNED and scan.records is not None:
                    records = scan.records                # kept by the scan: no re-read
                else:
                    chosen = (_downsample(scan.starts, scan.keys, max(50, (end - start) // 200),
                                          MAX_READS_RETURNED)
                              if total > MAX_READS_RETURNED else range(total))
                    records = self._records.read([scan.vofs[i] for i in chosen], is_current)
            if records is None:                            # superseded: the client has moved on
                return {"reads": [], "truncated": False, "total": 0, "total_exact": False,
                        "cancelled": True}
            reads = []
            for rec in records:
                rs, re, flag, mapq, name, cigar, seq = decode_record(rec)
                reads.append({
                    "start":    rs,
                    "end":      re,
                    "strand":   "-" if flag & 0x10 else "+",
                    "name":     name,
                    "mapq":     mapq,
                    "cigar":    "".join(f"{n}{op}" for n, op in cigar),
                    "segments": _cigar_to_segments(rs, cigar),
                    "sequence": seq,
                    "row":      0,
                })
        except Exception as e:
            # Corrupt/truncated BAM or index (a bad BGZF block, a malformed
            # record) — convert to a clear, actionable message.
            raise RuntimeError(_fetch_error_msg(self.file_path)) from e

        _assign_rows(reads)
        return {"reads": reads, "truncated": total > len(reads) or not scan.complete,
                "total": total, "total_exact": scan.complete}


def _downsample(starts, keys, width: int, cap: int) -> list[int]:
    """Indices (ascending) of exactly ``cap`` reads spread evenly over the view.

    Reads are bucketed by start position on a ``width``-bp grid aligned to
    absolute coordinates, so the grid stays put while panning at a fixed zoom,
    and reads that start left of the view fill buckets of their own instead of
    crowding the first one. Every bucket gets the same quota: the level at
    which the quotas add up to ``cap`` (water-filling — sparse buckets keep all
    their reads and their unused share goes to the dense ones; the few places
    left over go to dense buckets picked by a hash of their position). Within
    a bucket the reads with the smallest sampling key (a hash of name,
    position and flag) are kept, so the same reads stay selected as the view
    moves.
    """
    groups: dict[int, list[int]] = {}
    for i, s in enumerate(starts):
        g = groups.get(s // width)
        if g is None:
            groups[s // width] = [i]
        else:
            g.append(i)
    counts = sorted(len(g) for g in groups.values())
    left, n = cap, len(counts)
    for k, c in enumerate(counts):
        if c * (n - k) > left:                 # the n - k densest buckets share what is left
            level, extra = divmod(left, n - k)
            break
        left -= c
    else:
        return list(range(len(starts)))        # everything fits
    dense = sorted((b for b, g in groups.items() if len(g) > level),
                   key=lambda b: (zlib.crc32(b.to_bytes(8, "little", signed=True)), b))
    bonus = set(dense[:extra])
    chosen = []
    for b, g in groups.items():
        quota = level + (b in bonus)
        if len(g) <= quota:
            chosen.extend(g)
        else:
            ranked = sorted((keys[i] << 32) | i for i in g)
            chosen.extend(r & 0xFFFFFFFF for r in ranked[:quota])
    chosen.sort()
    return chosen


def _cigar_to_segments(ref_pos: int, cigar) -> list[dict]:
    """Convert a CIGAR (a string, or its parsed [(length, op)] list) into
    visual segments for the frontend.

    Returns a list of dicts, each with:
      type: 'M' (match/mismatch), 'D' (deletion), 'I' (insertion),
            'N' (skip), 'S' (soft-clip)
      start: reference position (for M/D/N)
      end:   reference position end (for M/D/N)
      pos:   reference position where insertion occurs (for I)
      length: number of inserted bases (for I)
    """
    if not cigar:
        return []

    ops = _parse_cigar(cigar) if isinstance(cigar, str) else cigar
    segments = []
    pos = ref_pos

    for length, op in ops:
        if op in ('M', '=', 'X'):
            # Match or mismatch — consumes both query and reference
            segments.append({"type": "M", "start": pos, "end": pos + length})
            pos += length
        elif op == 'D':
            # Deletion from reference — consumes reference only
            segments.append({"type": "D", "start": pos, "end": pos + length})
            pos += length
        elif op == 'N':
            # Skipped region (intron) — consumes reference only
            segments.append({"type": "N", "start": pos, "end": pos + length})
            pos += length
        elif op == 'I':
            # Insertion to reference — consumes query only, mark position
            segments.append({"type": "I", "pos": pos, "length": length})
        elif op == 'S':
            # Soft clip — consumes query only, note at current pos
            segments.append({"type": "S", "pos": pos, "length": length})
        # H (hard clip) and P (padding) don't consume either — skip

    return segments


def _assign_rows(reads: list[dict]):
    """Greedy row assignment so reads don't overlap visually."""
    row_ends: list[int] = []
    for r in sorted(reads, key=lambda x: x["start"]):
        placed = False
        for i, end in enumerate(row_ends):
            if r["start"] >= end:
                r["row"] = i
                row_ends[i] = r["end"]
                placed = True
                break
        if not placed:
            r["row"] = len(row_ends)
            row_ends.append(r["end"])
