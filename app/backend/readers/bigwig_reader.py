"""
Coverage readers for BigWig, BedGraph, and Wig formats — pure Python, no C deps.

BigWig is a binary format; we parse it using struct + zlib following the
UCSC BigWig specification:
  https://genome.ucsc.edu/goldenPath/help/bigWig.html

Text-based formats (.wig, .bedgraph, .bdg) also accept gzip-compressed
variants (.wig.gz, .bedgraph.gz, .bdg.gz) without re-extracting them.
"""

import gzip
import io
import itertools
import math
import struct
import zlib
from pathlib import Path


def _open_text(file_path: str):
    """Open a file as text, transparently decompressing .gz variants.
    Used by the WIG/BedGraph readers and by _sniff_wig_format."""
    p = str(file_path).lower()
    if p.endswith(".gz"):
        return gzip.open(file_path, "rt", encoding="utf-8", errors="replace")
    return open(file_path, "r", encoding="utf-8", errors="replace")


def _strip_chr(name: str) -> str:
    """Strip only a *leading* 'chr' prefix (case-insensitive) for chromosome-name
    matching. Using str.replace('chr','') would delete every occurrence and
    mangle names like 'scaffold_chr2' or collapse distinct contigs — so we only
    remove the prefix, mirroring the BAM reader's _norm_chrom."""
    return name[3:] if name[:3].lower() == "chr" else name


_INF = float("inf")
_finite = math.isfinite


class _Bins:
    """Bin accumulators for one coverage query over [start, end).

    Bin edges are the integer coordinates reported to the client, so every
    statistic describes exactly the bases its bar is drawn over. Each bin
    collects the base-pair-weighted sum and covered bp (→ mean) plus the
    extremes of the underlying signal (→ peak-preserving max/min): "max" is
    the largest positive-side value (>= 0) and "min" the smallest
    negative-side value (<= 0), so a bin holding only negative values reports
    max 0 and one holding only positive values min 0. Shared by all three
    readers, so a value in one format lands in the same bins as the same
    value in another."""

    __slots__ = ("start", "end", "n", "bs", "edges", "tot", "neg", "cnt", "mx", "mn", "signed")

    def __init__(self, start: int, end: int, bins: int):
        region_len = end - start
        self.start, self.end = start, end
        self.n = n = min(bins, region_len)
        self.bs = region_len / n
        self.edges = [start + int(i * self.bs) for i in range(n)] + [end]
        self.tot = [0.0] * n      # bp-weighted sum of the positive side
        self.neg = [0.0] * n      # bp-weighted sum of the negative side
        self.cnt = [0] * n        # covered bp
        self.mx = [0.0] * n       # largest positive-side value (0: none)
        self.mn = [0.0] * n       # smallest negative-side value (0: none)
        self.signed = False       # any negative value seen → report forward/reverse

    def first_bin(self, x: int) -> int:
        """Index of the bin containing position x."""
        n, edges = self.n, self.edges
        k = int((x - self.start) / self.bs)
        if k > n - 1:
            k = n - 1
        elif k < 0:
            k = 0
        while k > 0 and edges[k] > x:
            k -= 1
        while k < n - 1 and edges[k + 1] <= x:
            k += 1
        return k

    def add(self, s: int, e: int, v: float):
        """Add value ``v`` over [s, e) (already clipped to the query). The
        readers drop non-finite values before this; one that got here (NaN,
        ±inf) is ignored too, since it would make the response invalid JSON."""
        if not _finite(v):
            return
        edges, cnt, mx, mn = self.edges, self.cnt, self.mx, self.mn
        side = self.tot
        if v < 0:
            side = self.neg
            self.signed = True
        n = self.n
        k = self.first_bin(s)
        while k < n and edges[k] < e:
            lo, hi = edges[k], edges[k + 1]
            ov = (e if e < hi else hi) - (s if s > lo else lo)
            if ov > 0:
                side[k] += v * ov
                cnt[k] += ov
                if v > mx[k]:
                    mx[k] = v
                if v < mn[k]:
                    mn[k] = v
            k += 1

    def result(self) -> list[dict]:
        """One dict per bin. Signed data (any negative value in the query) also
        carries "forward"/"reverse" — the positive and negative sides' means —
        so a zoomed-out bin holding both doesn't cancel to a net value."""
        out = []
        edges, tot, neg = self.edges, self.tot, self.neg
        for i in range(self.n):
            c = self.cnt[i]
            if c:
                b = {"start": edges[i], "end": edges[i + 1], "value": (tot[i] + neg[i]) / c,
                     "max": self.mx[i], "min": self.mn[i], "cov": c}
                if self.signed:
                    b["forward"] = tot[i] / c
                    b["reverse"] = neg[i] / c
            else:
                b = {"start": edges[i], "end": edges[i + 1], "value": 0.0,
                     "max": 0.0, "min": 0.0, "cov": 0}
                if self.signed:
                    b["forward"] = b["reverse"] = 0.0
            out.append(b)
        return out


# ── BigWig constants ──────────────────────────────────────────────────────────

BIGWIG_MAGIC    = 0x888FFC26
BPTREE_MAGIC    = 0x78CA8C91
RTREE_MAGIC     = 0x2468ACE0
BW_TYPE_BEDGRAPH    = 1
BW_TYPE_VARSTEP     = 2
BW_TYPE_FIXSTEP     = 3


class BigWigReader:
    """
    Pure Python BigWig reader.
    Supports mean-stat queries over arbitrary regions via the R-tree index.
    """

    def __init__(self, file_path: str):
        self.file_path = file_path
        self._fh = open(file_path, "rb")
        self._chrom_to_id: dict[str, int] = {}
        self._id_to_chrom: dict[int, str] = {}
        self._chrom_sizes: dict[str, int] = {}
        self._uncompress_buf_size = 0
        self._full_index_offset = 0
        self._parse_header()
        self._parse_chrom_tree()
        self._has_neg = self._chrom_signs()

    def close(self):
        self._fh.close()

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chrom_sizes.items()]

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._chrom_to_id:
            return chrom
        if len(self._chrom_to_id) == 1:
            return next(iter(self._chrom_to_id))
        for key in self._chrom_to_id:
            if _strip_chr(key) == _strip_chr(chrom):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        if chrom not in self._chrom_to_id:
            return []
        chrom_id = self._chrom_to_id[chrom]
        region_len = end - start
        if region_len <= 0:
            return []

        acc = _Bins(start, end, bins)

        # Distribute each data block's contribution across the bins it
        # overlaps. The previous implementation expanded every block into
        # one (pos, value) tuple per base pair — fine for sparse Tn-seq
        # data, catastrophic for a BedGraph BigWig that summarises long
        # constant runs (e.g. a single block spanning 100 kbp at value 0
        # would allocate 100 k tuples). This walks the index once and does
        # O(blocks * bins_per_block) work instead.
        self._accumulate_blocks(chrom_id, start, end, acc)
        return acc.result()

    def _accumulate_blocks(self, chrom_id, region_start, region_end, acc):
        # Read R-tree header
        hdr = self._read(self._full_index_offset, 48)
        magic = struct.unpack_from("<L", hdr)[0]
        if magic != RTREE_MAGIC:
            raise ValueError("Bad R-tree magic")
        root_offset = self._full_index_offset + 48
        self._rtree_walk(root_offset, chrom_id, region_start, region_end, acc)

    def _rtree_walk(self, offset, chrom_id, region_start, region_end, acc):
        hdr = self._read(offset, 4)
        is_leaf, _, count = struct.unpack_from("<BBH", hdr)
        offset += 4
        if is_leaf:
            item_size = 32
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                (chr_s, bp_s, chr_e, bp_e, data_offset, data_size) = struct.unpack_from(
                    "<LLLLqq", data, base
                )
                if self._overlaps(chr_s, bp_s, chr_e, bp_e, chrom_id, region_start, region_end):
                    self._accumulate_data_block(
                        data_offset, data_size, chrom_id, region_start, region_end, acc
                    )
        else:
            item_size = 24
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                (chr_s, bp_s, chr_e, bp_e, child_offset) = struct.unpack_from(
                    "<LLLLq", data, base
                )
                if self._overlaps(chr_s, bp_s, chr_e, bp_e, chrom_id, region_start, region_end):
                    self._rtree_walk(child_offset, chrom_id, region_start, region_end, acc)

    # ── private ───────────────────────────────────────────────────────────────

    def _read(self, offset: int, size: int) -> bytes:
        self._fh.seek(offset)
        return self._fh.read(size)

    def _parse_header(self):
        data = self._read(0, 64)
        (magic, version, zoom_levels,
         chrom_tree_offset, full_data_offset, full_index_offset,
         field_count, defined_field_count,
         auto_sql_offset, total_summary_offset,
         uncompress_buf_size, reserved) = struct.unpack_from("<LHHQQQHHQQLQ", data)
        if magic != BIGWIG_MAGIC:
            raise ValueError(f"Not a BigWig file (magic={hex(magic)})")
        self._chrom_tree_offset = chrom_tree_offset
        self._full_index_offset = full_index_offset
        self._uncompress_buf_size = uncompress_buf_size
        self._zoom_levels = zoom_levels
        # The writer's whole-file summary (validCount, min, max, sum, sumSq):
        # its minimum says whether the file holds negative values at all.
        self._file_min = None
        if total_summary_offset:
            summary = self._read(total_summary_offset, 40)
            if len(summary) == 40:
                self._file_min = struct.unpack_from("<Qdddd", summary)[1]

    def has_negative(self, chrom: str):
        """Whether ``chrom`` holds negative values: True/False, or None when
        the file can't tell without reading its data (the client then decides
        per fetched window). Settled at open, so this does no file I/O; the
        API calls it outside the track lock."""
        return self._has_neg.get(self._resolve_chrom(chrom), False)

    def _chrom_signs(self) -> dict:
        """chrom -> has_negative answer, computed once at open.

        A file minimum >= 0 rules negatives out everywhere. Otherwise each
        chromosome's minimum comes from the coarsest zoom level's summary
        records, which the writer computed over all of the data: exact, and
        only a few records per chromosome. Without (usable) zoom levels, only
        a single-chromosome file can go by the file minimum."""
        fmin = self._file_min
        if fmin is not None and fmin >= 0:
            return dict.fromkeys(self._chrom_to_id, False)
        unknown = dict.fromkeys(self._chrom_to_id)    # None everywhere
        try:
            zoom = self._zoom_chrom_signs()
        except Exception:
            zoom = None                       # unreadable zoom data: as if absent
        if zoom is not None:
            # Zoom summaries that see no negative value anywhere contradict a
            # negative file minimum: trust neither.
            if fmin is not None and fmin < 0 and all(v is False for v in zoom.values()):
                return unknown
            return {c: zoom.get(cid, False) for c, cid in self._chrom_to_id.items()}
        if len(self._chrom_to_id) == 1 and fmin is not None and _finite(fmin):
            return dict.fromkeys(self._chrom_to_id, fmin < 0)
        return unknown

    def _zoom_chrom_signs(self):
        """{chromId: True/False/None} from the coarsest zoom level, or None
        when the file has none. Each summary record is (chromId, start, end,
        validCount, minVal, maxVal, sum, sumSq); a chromosome without records
        holds no data. A -inf or NaN minVal (values get_coverage drops) hides
        whether finite negative values are there too, so it leaves the answer
        open (None) unless another record shows one."""
        if not self._zoom_levels:
            return None
        # (reductionLevel, reserved, dataOffset, indexOffset) per level; the
        # largest reduction has the fewest records.
        hdrs = self._read(64, 24 * self._zoom_levels)
        index_offset = max(struct.iter_unpack("<LLQQ", hdrs))[3]
        if struct.unpack_from("<L", self._read(index_offset, 4))[0] != RTREE_MAGIC:
            raise ValueError("Bad zoom R-tree magic")
        signs = {}
        for offset, size in self._rtree_blocks(index_offset + 48):
            raw = self._read(offset, size)
            if self._uncompress_buf_size > 0:
                raw = zlib.decompress(raw)
            for chrom_id, _, _, valid, lo in struct.iter_unpack("<LLLLf12x", raw[:len(raw) // 32 * 32]):
                if not valid or signs.get(chrom_id):
                    continue
                if _finite(lo):
                    if lo < 0:
                        signs[chrom_id] = True
                    else:
                        signs.setdefault(chrom_id, False)
                elif lo != _INF:              # -inf or NaN
                    signs[chrom_id] = None
        return signs

    def _rtree_blocks(self, offset: int) -> list:
        """(dataOffset, dataSize) of every data block under the R-tree node at
        ``offset``."""
        is_leaf, _, count = struct.unpack_from("<BBH", self._read(offset, 4))
        if is_leaf:
            data = self._read(offset + 4, count * 32)
            return [struct.unpack_from("<qq", data, i * 32 + 16) for i in range(count)]
        data = self._read(offset + 4, count * 24)
        blocks = []
        for i in range(count):
            blocks += self._rtree_blocks(struct.unpack_from("<q", data, i * 24 + 16)[0])
        return blocks

    def _parse_chrom_tree(self):
        off = self._chrom_tree_offset
        hdr = self._read(off, 32)
        magic, block_size, key_size, val_size, item_count, _ = struct.unpack_from("<LLLLQQ", hdr)
        if magic != BPTREE_MAGIC:
            raise ValueError("Bad chromosome B+ tree magic")
        self._key_size = key_size
        self._traverse_bptree(off + 32, key_size, val_size)

    def _traverse_bptree(self, offset: int, key_size: int, val_size: int):
        hdr = self._read(offset, 4)
        is_leaf, _, count = struct.unpack_from("<BBH", hdr)
        offset += 4
        if is_leaf:
            item_size = key_size + val_size
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                key_bytes = data[base: base + key_size]
                chrom = key_bytes.rstrip(b"\x00").decode("ascii", errors="replace")
                chrom_id, chrom_size = struct.unpack_from("<LL", data, base + key_size)
                self._chrom_to_id[chrom] = chrom_id
                self._id_to_chrom[chrom_id] = chrom
                self._chrom_sizes[chrom] = chrom_size
        else:
            item_size = key_size + 8
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                child_offset, = struct.unpack_from("<Q", data, base + key_size)
                self._traverse_bptree(child_offset, key_size, val_size)

    @staticmethod
    def _overlaps(chr_s, bp_s, chr_e, bp_e, chrom_id, start, end) -> bool:
        if chr_s > chrom_id or chr_e < chrom_id:
            return False
        if chr_s == chr_e == chrom_id:
            return bp_s < end and bp_e > start
        return True

    def _accumulate_data_block(self, offset, size, chrom_id, region_start, region_end, acc):
        """Decompress one data block and add its (range, value) entries to the bin
        accumulators. Each input range contributes ``overlap`` to the covered bp
        of each bin it touches, ``overlap * value`` to that bin's total, and its
        value to the bin's max/min — the mean comes out the same as a
        per-position implementation without one tuple per base pair."""
        raw = self._read(offset, size)
        if self._uncompress_buf_size > 0:
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                return

        if len(raw) < 24:
            return
        # itemCount is an unsigned 16-bit field in the spec; reading it signed
        # would skip every section holding 32,768-65,535 items.
        chrom_id_sec, chrom_start, chrom_end, item_step, item_span, bw_type, _, item_count = \
            struct.unpack_from("<LLLLLBBH", raw, 0)
        if chrom_id_sec != chrom_id:
            return

        pos = 24
        add = acc.add
        finite = _finite

        def add_range(s, e, v):
            # Skip NaN and ±inf (e.g. a log ratio's log(0)), like the WIG reader.
            if s >= region_end or e <= region_start or not finite(v):
                return
            cs = s if s > region_start else region_start
            ce = e if e < region_end else region_end
            if cs < ce:
                add(cs, ce, v)

        if bw_type == BW_TYPE_BEDGRAPH:
            for _ in range(item_count):
                if pos + 12 > len(raw): break
                s, e, v = struct.unpack_from("<LLf", raw, pos)
                pos += 12
                add_range(s, e, v)
        elif bw_type == BW_TYPE_VARSTEP:
            for _ in range(item_count):
                if pos + 8 > len(raw): break
                s, v = struct.unpack_from("<Lf", raw, pos)
                pos += 8
                add_range(s, s + item_span, v)
        elif bw_type == BW_TYPE_FIXSTEP:
            cur = chrom_start
            for _ in range(item_count):
                if pos + 4 > len(raw): break
                v, = struct.unpack_from("<f", raw, pos)
                pos += 4
                add_range(cur, cur + item_span, v)
                cur += item_step


# ── BedGraph (text) ───────────────────────────────────────────────────────────

import bisect

class BedGraphReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._data: dict[str, list] = {}   # chrom -> [(start, end, value), ...]
        self._starts: dict[str, list] = {} # chrom -> [start, start, ...] for bisect
        self._max_end: dict[str, list] = {}  # chrom -> running max of ends
        self._chroms: dict[str, int] = {}
        self._load()

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._data:
            return chrom
        if len(self._data) == 1:
            return next(iter(self._data))
        for key in self._data:
            if _strip_chr(key) == _strip_chr(chrom):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def _load(self):
        finite = _finite
        with _open_text(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("track", "browser", "#")):
                    continue
                parts = line.split()
                if len(parts) < 4:
                    continue
                try:
                    chrom, start, end, value = parts[0], int(parts[1]), int(parts[2]), float(parts[3])
                except (ValueError, IndexError):
                    continue
                # Drop NaN and ±inf ("inf", or "1e400" overflowing), like the
                # WIG reader: they can't be drawn, a -inf must not mark the
                # chromosome as signed, and any one would make the response
                # invalid JSON.
                if not finite(value):
                    continue
                self._data.setdefault(chrom, []).append((start, end, value))
                self._chroms[chrom] = max(self._chroms.get(chrom, 0), end)
        for chrom in self._data:
            self._data[chrom].sort()
            self._starts[chrom] = [e[0] for e in self._data[chrom]]
            # Running max of interval ends: the first entry that can reach a
            # query start is found by bisecting this (non-decreasing) list, so
            # an earlier long interval covering the start is never skipped.
            self._max_end[chrom] = list(itertools.accumulate((e[1] for e in self._data[chrom]), max))
        self._has_neg = {c: any(e[2] < 0 for e in d) for c, d in self._data.items()}

    def has_negative(self, chrom: str) -> bool:
        return self._has_neg.get(self._resolve_chrom(chrom), False)

    def close(self): pass

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chroms.items()]

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        entries = self._data.get(chrom, [])
        region_len = end - start
        if region_len <= 0 or not entries:
            return []
        acc = _Bins(start, end, bins)
        add = acc.add
        # First entry whose interval can reach the query start.
        lo = bisect.bisect_right(self._max_end[chrom], start)
        for i in range(lo, len(entries)):
            s, e, v = entries[i]
            if s >= end:
                break
            if e <= start:
                continue
            # Weight by base-pair overlap (matches the BigWig/WIG readers) so a
            # bin reports the true bp mean rather than an unweighted average of
            # every interval that happens to touch it.
            add(s if s > start else start, e if e < end else end, v)
        return acc.result()


# ── Wig (text) ────────────────────────────────────────────────────────────────

import re

class WigReader:
    """
    Robust WIG reader that handles:
    - variableStep and fixedStep formats
    - Negative values (e.g. Tn-seq reverse-strand reads)
    - Duplicate records (same position and span, e.g. one per strand) —
      merged into one site, so its bases are counted once
    - 1-based WIG coords → 0-based internal coords

    Every record is stored as aligned per-position arrays: the forward
    (positive) side and the reverse (negative, <= 0) side, built once at load
    for fast binary-search queries without per-request allocation.
    """

    def __init__(self, file_path: str):
        self.file_path = file_path
        self._positions: dict[str, list] = {} # chrom -> [pos, pos, ...] sorted (repeats only with different spans)
        self._spans: dict[str, list] = {}     # chrom -> [span, ...] matching
        self._fwd: dict[str, list] = {}       # chrom -> positive-side value per position (>= 0)
        self._rev: dict[str, list] = {}       # chrom -> negative-side value per position (<= 0)
        self._chroms: dict[str, int] = {}     # chrom -> max_position
        self._max_span = 1
        self.merged_duplicates = 0            # records folded into an existing site (same position and span)
        self._load()

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._positions:
            return chrom
        if len(self._positions) == 1:
            return next(iter(self._positions))
        # Try common prefix/suffix variations (chr1 vs 1, Chr1 vs chr1)
        for key in self._positions:
            if _strip_chr(key) == _strip_chr(chrom):
                return key
            if key.lower() == chrom.lower():
                return key
        return chrom

    def _load(self):
        chrom = None
        step = span = 1
        pos = 1
        fixed = False
        # Every record becomes one aligned (position, span, forward, reverse)
        # entry: "forward" is the positive side (a value >= 0, or the fwd
        # column) and "reverse" the negative side (a value < 0, or -|rev
        # column|), so single-value signed files (Tn-seq) and 3-column fwd/rev
        # files share one model and the arrays can never desync.
        positions: dict[str, list] = {}
        fwds: dict[str, list] = {}
        revs: dict[str, list] = {}
        spans: dict[str, list] = {}   # per-entry span (width) so binning honors span=N
        chroms: dict[str, int] = {}
        header_seen = False
        finite = math.isfinite

        def open_chrom(ch):
            for d in (positions, fwds, revs, spans):
                d.setdefault(ch, [])

        def rec(ch, p0, sp, f, r):
            positions[ch].append(p0)
            spans[ch].append(sp)
            fwds[ch].append(f)
            revs[ch].append(r)
            if p0 + sp > chroms.get(ch, 0):
                chroms[ch] = p0 + sp

        with _open_text(self.file_path) as f:
            for line in f:
                # Fast path: most lines are data. Classify by the first
                # non-blank character, so space-padded columns and values
                # written as "+2", ".5", "nan" or "inf" are data too (a dropped
                # fixedStep line would shift every later position).
                c0 = line[0] if line else '\n'
                if c0 == ' ' or c0 == '\t':
                    stripped = line.lstrip()
                    c0 = stripped[0] if stripped else '\n'

                if c0 == '#' or c0 == '\n' or c0 == '\r':
                    continue

                is_data = c0.isdigit() or c0 in '-+.' or line.lstrip()[:3].lower() in ('nan', 'inf')
                if not is_data and fixed and not line.lstrip().startswith(
                        ('variableStep', 'fixedStep', 'track', 'browser')):
                    is_data = True      # e.g. "NA": unparseable, but it still occupies a step
                if is_data:
                    # Headerless file: use placeholder chrom name
                    if not chrom:
                        chrom = "_headerless"
                        open_chrom(chrom)
                        header_seen = True

                    parts = line.split()
                    try:
                        if fixed:
                            # Advance BEFORE parsing: a value that fails to
                            # parse still consumes its step.
                            p0 = pos - 1
                            pos += step
                            v = float(parts[0])
                            if len(parts) >= 2:                 # fixedStep "fwd rev"
                                rv = float(parts[1])
                                if finite(v) and finite(rv):
                                    rec(chrom, p0, span, v if v > 0 else 0.0, -abs(rv) + (v if v < 0 else 0.0))
                            elif finite(v):
                                rec(chrom, p0, span, v if v > 0 else 0.0, v if v < 0 else 0.0)
                        elif len(parts) >= 3:
                            p0 = int(parts[0])              # this 3-column dialect is 0-based (by design)
                            fwd = float(parts[1])
                            rv = float(parts[2])
                            if finite(fwd) and finite(rv):
                                rec(chrom, p0, span, fwd if fwd > 0 else 0.0, -abs(rv) + (fwd if fwd < 0 else 0.0))
                        elif len(parts) >= 2:
                            v = float(parts[1])
                            if finite(v):
                                rec(chrom, int(parts[0]) - 1, span, v if v > 0 else 0.0, v if v < 0 else 0.0)
                        else:
                            # Single column — treat as fixedStep value
                            p0 = pos - 1
                            pos += 1
                            v = float(parts[0])
                            if finite(v):
                                rec(chrom, p0, 1, v if v > 0 else 0.0, v if v < 0 else 0.0)
                    except (ValueError, IndexError):
                        pass
                    continue

                # Header lines — only checked until first data line
                line = line.strip()
                if not line:
                    continue

                if 'variableStep' in line:
                    idx = line.index('variableStep')
                    tail = line[idx:]
                    params = dict(re.findall(r"(\w+)=(\S+)", tail))
                    chrom = params.get("chrom")
                    if chrom:
                        fixed = False
                        span = int(params.get("span", 1))
                        open_chrom(chrom)
                        header_seen = True
                    continue

                if 'fixedStep' in line:
                    idx = line.index('fixedStep')
                    tail = line[idx:]
                    params = dict(re.findall(r"(\w+)=(\S+)", tail))
                    chrom = params.get("chrom")
                    if chrom:
                        fixed = True
                        pos = int(params.get("start", 1))
                        step = int(params.get("step", 1))
                        span = int(params.get("span", 1))
                        open_chrom(chrom)
                        header_seen = True
                    continue

                # BedGraph-style fallback (4+ columns with chrom)
                if not header_seen:
                    parts = line.split()
                    if len(parts) >= 4:
                        try:
                            c = parts[0]
                            s = int(parts[1])
                            e = int(parts[2])
                            v = float(parts[3])
                            if finite(v):
                                open_chrom(c)
                                rec(c, s, max(1, e - s), v if v > 0 else 0.0, v if v < 0 else 0.0)
                        except (ValueError, IndexError):
                            pass

        self._chroms = chroms
        for ch in positions:
            p, sp, fw, rv = positions[ch], spans[ch], fwds[ch], revs[ch]
            # Sort the parallel arrays TOGETHER (stable, so duplicates keep file
            # order) — a WIG whose positions aren't monotonically increasing
            # would otherwise return wrong bins via bisect.
            if any(p[i] > p[i + 1] for i in range(len(p) - 1)):
                order = sorted(range(len(p)), key=p.__getitem__)
                p = [p[i] for i in order]
                sp = [sp[i] for i in order]
                fw = [fw[i] for i in order]
                rv = [rv[i] for i in order]
            # Merge records at the same position and span (e.g. a Tn-seq TA
            # site listed once per strand: "803145 2123.18" and "803145
            # -8.23") into one site — sides summed — so its bases are counted
            # once. Counting them per record halved both strands at every
            # zoom. Records of different spans stay separate entries: folding
            # one into the other would spread its value over the wrong bases.
            if len(set(p)) != len(p):
                P, S, F, R = [p[0]], [sp[0]], [fw[0]], [rv[0]]
                run = 0                       # first entry at the current position
                for i in range(1, len(p)):
                    if p[i] == P[-1]:
                        j = len(P) - 1        # the same-span entry, usually the last
                        while j >= run and S[j] != sp[i]:
                            j -= 1
                        if j >= run:
                            F[j] += fw[i]
                            R[j] += rv[i]
                            self.merged_duplicates += 1
                            continue
                    else:
                        run = len(P)
                    P.append(p[i]); S.append(sp[i]); F.append(fw[i]); R.append(rv[i])
                p, sp, fw, rv = P, S, F, R
            self._positions[ch], self._spans[ch], self._fwd[ch], self._rev[ch] = p, sp, fw, rv
            if sp:
                self._max_span = max(self._max_span, max(sp))
        # Whole-chromosome sign, so the split (forward up / reverse down) layout
        # is decided once instead of flipping as sparse signed data is panned.
        self._has_neg = {ch: any(r < 0 for r in self._rev[ch]) for ch in self._rev}

    def has_negative(self, chrom: str) -> bool:
        return self._has_neg.get(self._resolve_chrom(chrom), False)

    def close(self): pass

    @property
    def chromosomes(self) -> list[dict]:
        return [{"name": k, "length": v} for k, v in self._chroms.items()]

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        positions = self._positions.get(chrom, [])
        region_len = end - start
        if region_len <= 0 or not positions:
            return []
        spans, fwd, rev = self._spans[chrom], self._fwd[chrom], self._rev[chrom]
        acc = _Bins(start, end, bins)
        n, edges, tot, neg, cnt, mx, mn = acc.n, acc.edges, acc.tot, acc.neg, acc.cnt, acc.mx, acc.mn

        # Start early enough to catch entries that begin left of the region but
        # whose span reaches into it. Each entry covers [p, p+span); its value is
        # spread across the bins it overlaps, weighted by base-pair overlap, so
        # span=N and sub-bin/edge entries bin correctly.
        lo = bisect.bisect_left(positions, start - self._max_span)
        k = 0          # bin holding the current entry's start (entries are sorted)
        for i in range(lo, len(positions)):
            p = positions[i]
            if p >= end:
                break
            q = p + spans[i]
            s = p if p > start else start
            e = q if q < end else end
            if s >= e:
                continue
            while k < n - 1 and edges[k + 1] <= s:
                k += 1
            f, r = fwd[i], rev[i]
            j = k
            while j < n and edges[j] < e:
                b_lo, b_hi = edges[j], edges[j + 1]
                ov = (e if e < b_hi else b_hi) - (s if s > b_lo else b_lo)
                if ov > 0:
                    cnt[j] += ov
                    tot[j] += f * ov
                    neg[j] += r * ov              # reverse side renders below the axis
                    if f > mx[j]:
                        mx[j] = f
                    if r < mn[j]:
                        mn[j] = r
                j += 1

        out = []
        for i in range(n):
            c = cnt[i]
            if c:
                out.append({"start": edges[i], "end": edges[i + 1],
                            "value": (tot[i] + neg[i]) / c, "forward": tot[i] / c, "reverse": neg[i] / c,
                            "max": mx[i], "min": mn[i], "cov": c})
            else:
                out.append({"start": edges[i], "end": edges[i + 1], "value": 0.0,
                            "forward": 0.0, "reverse": 0.0, "max": 0.0, "min": 0.0, "cov": 0})
        return out


# ── Factory ───────────────────────────────────────────────────────────────────

def _sniff_wig_format(file_path: str) -> str:
    """Peek at the first lines to detect if a .wig file is actually BedGraph format."""
    try:
        with _open_text(file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("browser",)):
                    continue
                # #bedGraph header is a strong signal
                if line.startswith("#bedGraph") or line.startswith("#bedgraph"):
                    return "bedgraph"
                if line.startswith("#"):
                    continue
                if line.startswith("track"):
                    # Only the type= token decides — a name or description that
                    # merely mentions "bedGraph" must not misroute a WIG.
                    if re.search(r"\btype=bedgraph\b", line, re.I):
                        return "bedgraph"
                    continue
                # Check for variableStep/fixedStep anywhere in the line
                # (handles non-standard files where it's embedded in metadata)
                if "variableStep" in line or "fixedStep" in line:
                    return "wig"
                if line.startswith(("fixedStep", "variableStep")):
                    return "wig"
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        int(parts[1]); int(parts[2]); float(parts[3])
                        return "bedgraph"
                    except ValueError:
                        pass
                return "wig"
    except Exception:
        pass
    return "wig"


def _coverage_compound_ext(file_path: str) -> str:
    """Return the meaningful extension, treating .wig.gz / .bedgraph.gz /
    .bdg.gz as their underlying format (Path.suffix only ever returns
    '.gz' on its own)."""
    name = str(file_path).lower()
    for compound in (".wig.gz", ".bedgraph.gz", ".bdg.gz"):
        if name.endswith(compound):
            return compound[:-len(".gz")]  # drop the .gz, keep .wig / .bedgraph / .bdg
    return Path(file_path).suffix.lower()


def make_coverage_reader(file_path: str):
    ext = _coverage_compound_ext(file_path)
    if ext in (".bw", ".bigwig"):
        return BigWigReader(file_path)
    if ext in (".bedgraph", ".bdg"):
        return BedGraphReader(file_path)
    if ext == ".wig":
        # Some .wig files are actually BedGraph format — auto-detect.
        # _sniff_wig_format transparently handles gzip-compressed variants.
        fmt = _sniff_wig_format(file_path)
        if fmt == "bedgraph":
            return BedGraphReader(file_path)
        return WigReader(file_path)
    raise ValueError(f"Unsupported coverage format: {ext}")
