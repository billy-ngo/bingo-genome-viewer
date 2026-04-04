"""
Coverage readers for BigWig, BedGraph, and Wig formats — pure Python, no C deps.

BigWig is a binary format; we parse it using struct + zlib following the
UCSC BigWig specification:
  https://genome.ucsc.edu/goldenPath/help/bigWig.html
"""

import struct
import zlib
from pathlib import Path


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
        return chrom

    def get_coverage(self, chrom: str, start: int, end: int, bins: int = 1000) -> list[dict]:
        chrom = self._resolve_chrom(chrom)
        if chrom not in self._chrom_to_id:
            return []
        chrom_id = self._chrom_to_id[chrom]
        region_len = end - start
        if region_len <= 0:
            return []

        # Collect all (pos, value) pairs from overlapping data blocks
        points = self._fetch_points(chrom_id, start, end)

        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        totals = [0.0] * n_bins
        counts = [0]  * n_bins

        for pos, val in points:
            if pos < start or pos >= end:
                continue
            bi = int((pos - start) / bin_size)
            bi = min(bi, n_bins - 1)
            totals[bi] += val
            counts[bi] += 1

        result = []
        for i in range(n_bins):
            result.append({
                "start": int(start + i * bin_size),
                "end":   int(start + (i + 1) * bin_size),
                "value": totals[i] / counts[i] if counts[i] else 0.0,
            })
        return result

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

    def _fetch_points(self, chrom_id: int, start: int, end: int):
        """Walk R-tree and yield (position, value) for all overlapping records."""
        # Read R-tree header
        hdr = self._read(self._full_index_offset, 48)
        magic = struct.unpack_from("<L", hdr)[0]
        if magic != RTREE_MAGIC:
            raise ValueError("Bad R-tree magic")
        root_offset = self._full_index_offset + 48
        points = []
        self._rtree_search(root_offset, chrom_id, start, end, points)
        return points

    def _rtree_search(self, offset: int, chrom_id: int, start: int, end: int, out: list):
        hdr = self._read(offset, 4)
        is_leaf, _, count = struct.unpack_from("<BBH", hdr)
        offset += 4
        if is_leaf:
            item_size = 32  # chromIxStart(4)+baseStart(4)+chromIxEnd(4)+baseEnd(4)+dataOffset(8)+dataSize(8)
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                (chr_start, bp_start, chr_end, bp_end,
                 data_offset, data_size) = struct.unpack_from("<LLLLqq", data, base)
                if self._overlaps(chr_start, bp_start, chr_end, bp_end, chrom_id, start, end):
                    self._read_data_block(data_offset, data_size, chrom_id, start, end, out)
        else:
            item_size = 24  # chromIxStart(4)+baseStart(4)+chromIxEnd(4)+baseEnd(4)+dataOffset(8)
            data = self._read(offset, count * item_size)
            for i in range(count):
                base = i * item_size
                (chr_start, bp_start, chr_end, bp_end,
                 child_offset) = struct.unpack_from("<LLLLq", data, base)
                if self._overlaps(chr_start, bp_start, chr_end, bp_end, chrom_id, start, end):
                    self._rtree_search(child_offset, chrom_id, start, end, out)

    @staticmethod
    def _overlaps(chr_s, bp_s, chr_e, bp_e, chrom_id, start, end) -> bool:
        if chr_s > chrom_id or chr_e < chrom_id:
            return False
        if chr_s == chr_e == chrom_id:
            return bp_s < end and bp_e > start
        return True

    def _read_data_block(self, offset: int, size: int, chrom_id: int, start: int, end: int, out: list):
        raw = self._read(offset, size)
        if self._uncompress_buf_size > 0:
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                return

        # Section header: chromId(4) chromStart(4) chromEnd(4) itemStep(4) itemSpan(4) type(1) reserved(1) itemCount(2)
        if len(raw) < 24:
            return
        chrom_id_sec, chrom_start, chrom_end, item_step, item_span, bw_type, _, item_count = \
            struct.unpack_from("<LLLLLBBh", raw, 0)
        if chrom_id_sec != chrom_id:
            return

        pos = 24  # offset after section header
        if bw_type == BW_TYPE_BEDGRAPH:
            for _ in range(item_count):
                if pos + 12 > len(raw): break
                s, e, v = struct.unpack_from("<LLf", raw, pos)
                pos += 12
                if s < end and e > start:
                    for p in range(max(s, start), min(e, end)):
                        out.append((p, v))
        elif bw_type == BW_TYPE_VARSTEP:
            for _ in range(item_count):
                if pos + 8 > len(raw): break
                s, v = struct.unpack_from("<Lf", raw, pos)
                pos += 8
                for p in range(s, s + item_span):
                    if start <= p < end:
                        out.append((p, v))
        elif bw_type == BW_TYPE_FIXSTEP:
            cur = chrom_start
            for _ in range(item_count):
                if pos + 4 > len(raw): break
                v, = struct.unpack_from("<f", raw, pos)
                pos += 4
                for p in range(cur, cur + item_span):
                    if start <= p < end:
                        out.append((p, v))
                cur += item_step


# ── BedGraph (text) ───────────────────────────────────────────────────────────

class BedGraphReader:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self._data: dict[str, list] = {}
        self._chroms: dict[str, int] = {}
        self._load()

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._data:
            return chrom
        if len(self._data) == 1:
            return next(iter(self._data))
        return chrom

    def _load(self):
        with open(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("track", "browser", "#")):
                    continue
                parts = line.split()
                if len(parts) < 4:
                    continue
                chrom, start, end, value = parts[0], int(parts[1]), int(parts[2]), float(parts[3])
                self._data.setdefault(chrom, []).append((start, end, value))
                self._chroms[chrom] = max(self._chroms.get(chrom, 0), end)
        for chrom in self._data:
            self._data[chrom].sort()

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
        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        totals = [0.0] * n_bins
        counts = [0] * n_bins
        for (s, e, v) in entries:
            if e <= start or s >= end:
                continue
            bi_s = int((max(s, start) - start) / bin_size)
            bi_e = min(int((min(e, end) - 1 - start) / bin_size) + 1, n_bins)
            for bi in range(bi_s, bi_e):
                totals[bi] += v
                counts[bi] += 1
        return [{"start": int(start + i * bin_size), "end": int(start + (i + 1) * bin_size),
                 "value": totals[i] / counts[i] if counts[i] else 0.0} for i in range(n_bins)]


# ── Wig (text) ────────────────────────────────────────────────────────────────

import re
import bisect

class WigReader:
    """
    Robust WIG reader that handles:
    - variableStep and fixedStep formats
    - Negative values (e.g. Tn-seq reverse-strand reads)
    - Duplicate positions (same position, different strands)
    - 1-based WIG coords → 0-based internal coords
    """

    def __init__(self, file_path: str):
        self.file_path = file_path
        # Store as sorted list of (position, value) tuples — allows duplicates
        self._data: dict[str, list] = {}   # chrom -> [(pos, value), ...]
        self._chroms: dict[str, int] = {}  # chrom -> max_position
        self._load()

    def _resolve_chrom(self, chrom: str) -> str:
        if chrom in self._data:
            return chrom
        if len(self._data) == 1:
            return next(iter(self._data))
        return chrom

    def _load(self):
        chrom = None
        step = span = 1
        pos = 1
        fixed = False
        raw: dict[str, list] = {}  # collect unsorted first

        with open(self.file_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith(("#", "browser", "track")):
                    continue
                if line.startswith("fixedStep"):
                    fixed = True
                    params = dict(re.findall(r"(\w+)=(\S+)", line))
                    chrom = params.get("chrom")
                    if not chrom:
                        continue
                    pos = int(params.get("start", 1))
                    step = int(params.get("step", 1))
                    span = int(params.get("span", 1))
                    raw.setdefault(chrom, [])
                elif line.startswith("variableStep"):
                    fixed = False
                    params = dict(re.findall(r"(\w+)=(\S+)", line))
                    chrom = params.get("chrom")
                    if not chrom:
                        continue
                    span = int(params.get("span", 1))
                    raw.setdefault(chrom, [])
                elif chrom:
                    parts = line.split()
                    try:
                        if fixed:
                            v = float(parts[0])
                            # WIG is 1-based; convert to 0-based
                            p0 = pos - 1
                            raw[chrom].append((p0, v))
                            self._chroms[chrom] = max(self._chroms.get(chrom, 0), p0 + span)
                            pos += step
                        elif len(parts) >= 2:
                            p0 = int(parts[0]) - 1  # 1-based → 0-based
                            v = float(parts[1])
                            raw[chrom].append((p0, v))
                            self._chroms[chrom] = max(self._chroms.get(chrom, 0), p0 + span)
                    except (ValueError, IndexError):
                        continue  # skip malformed lines

        # Sort by position for fast binary-search queries
        for chrom, entries in raw.items():
            entries.sort(key=lambda x: x[0])
            self._data[chrom] = entries

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

        n_bins = min(bins, region_len)
        bin_size = region_len / n_bins
        pos_totals = [0.0] * n_bins  # forward (positive values)
        neg_totals = [0.0] * n_bins  # reverse (negative values)

        # Binary search for start of relevant data
        positions = [e[0] for e in entries]
        lo = bisect.bisect_left(positions, start)

        for i in range(lo, len(entries)):
            p, v = entries[i]
            if p >= end:
                break
            bi = min(int((p - start) / bin_size), n_bins - 1)
            if v >= 0:
                pos_totals[bi] += v
            else:
                neg_totals[bi] += v

        return [
            {
                "start": int(start + i * bin_size),
                "end": int(start + (i + 1) * bin_size),
                "value": pos_totals[i] + neg_totals[i],  # net value
                "forward": pos_totals[i],
                "reverse": neg_totals[i],
            }
            for i in range(n_bins)
        ]


# ── Factory ───────────────────────────────────────────────────────────────────

def make_coverage_reader(file_path: str):
    ext = Path(file_path).suffix.lower()
    if ext in (".bw", ".bigwig"):
        return BigWigReader(file_path)
    elif ext in (".bedgraph", ".bdg"):
        return BedGraphReader(file_path)
    elif ext == ".wig":
        return WigReader(file_path)
    else:
        raise ValueError(f"Unsupported coverage format: {ext}")
