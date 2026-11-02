"""
Exact per-base read depth for a BAM, built once in a background thread.

Zoomed-out coverage used to be computed live by iterating reads through
bamnostic (~25k reads/s) with a 500k-read cap, so on a deep ChIP BAM the
whole-chromosome view showed coverage for the first few kb and zeros after.
Instead the BAM is streamed once by a minimal BGZF/BAM record scanner
(gzip + struct — pure Python, ~600k reads/s), accumulating a per-base depth
difference array per contig; every coverage query is then answered exactly
(mean / max / min depth per bin) at any zoom.

Counting rules match IGV's defaults, so coverage agrees with the read pileup:
reads flagged unmapped (0x4), QC-fail (0x200) or duplicate (0x400) are
skipped (secondary/supplementary alignments count), and only aligned bases
(CIGAR M/=/X) count — deletions and introns (D/N) do not.

While the scan is running, positions the scan has already passed are final
(the BAM is coordinate-sorted), so queries are answered exactly up to that
point and the remaining bins are returned with ``pending: True``.
"""

import array
import gzip
import itertools
import os
import struct
import threading
from pathlib import Path

SKIP_FLAGS = 0x4 | 0x200 | 0x400           # unmapped | QC-fail | duplicate (IGV defaults)
_CHUNK = 1 << 22                            # uncompressed bytes per read() of the stream
_BLOCK = 64                                 # bp per pre-aggregated block for fast zoomed-out queries
# The index holds two int32 arrays per reference base at its peak (difference
# + depth), so cap it at genome sizes this viewer targets; larger references
# fall back to the live (bounded) pileup.
MAX_INDEX_BP = 32_000_000


class IndexTooLarge(Exception):
    pass


class BamCoverageIndex:
    """Background-built exact depth for every contig of one BAM file."""

    def __init__(self, path: str, start: bool = True):
        self.path = str(path)
        self.state = "building"          # building | ready | failed | unsupported | cancelled
        self.error: str | None = None
        self.progress = 0.0              # fraction of the compressed file consumed
        self._lengths: dict[str, int] = {}
        self._diff: dict[str, array.array] = {}
        self._depth: dict[str, array.array] = {}
        self._blk_sum: dict[str, array.array] = {}
        self._blk_max: dict[str, array.array] = {}
        self._blk_min: dict[str, array.array] = {}
        self._final_upto: dict[str, int] = {}   # positions < value are final
        self._max_span: dict[str, int] = {}     # longest reference span of any mapped read
        self._names: list[str] = []
        self._raw = None
        self._gz = None
        self._cancel = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name=f"bam-coverage:{Path(self.path).name}")
        # Read the header synchronously (milliseconds) so contigs are known the
        # moment the track exists; only the record scan runs in the background.
        try:
            self._open()
        except IndexTooLarge as e:
            self._close_file()
            self.error, self.state, start = str(e), "unsupported", False
        except Exception as e:
            self._close_file()
            self.error, self.state, start = f"{type(e).__name__}: {e}", "failed", False
        if start:
            self._thread.start()

    # ── public ──────────────────────────────────────────────────────────

    def cancel(self):
        self._cancel.set()

    def wait(self, timeout=None) -> bool:
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def status(self) -> dict:
        return {"state": self.state, "progress": round(self.progress, 4), "error": self.error}

    def has_contig(self, name: str) -> bool:
        return name in self._lengths

    def max_span(self, name: str) -> int | None:
        """Longest reference span of a mapped read on ``name``; None until the
        scan has finished (callers then use a conservative default)."""
        return self._max_span.get(name) if self.state == "ready" else None

    def coverage(self, contig: str, start: int, end: int, bins: int) -> list[dict]:
        """Bins over [start, end): exact mean / max / min depth per bin.

        Bin edges are the integer coordinates reported to the client, so the
        statistics describe exactly the bases each bar is drawn over. Bins past
        the contig end are empty (value 0, ``cov`` 0). While the background scan
        is still running, bins it has not reached are returned with
        ``pending: True`` and zero values."""
        region_len = end - start
        if region_len <= 0 or contig not in self._lengths:
            return []
        L = self._lengths[contig]
        n = min(bins, region_len)
        bs = region_len / n
        edges = [start + int(i * bs) for i in range(n)] + [end]

        ready = self.state == "ready"
        diff = None
        if not ready:
            diff = self._diff.get(contig)
            if diff is None:             # the build finished between the two reads
                ready = self.state == "ready"
        if ready:
            depth = self._depth[contig]
            avail = L
        elif diff is None:               # failed / cancelled: nothing usable
            return []
        else:
            avail = min(self._final_upto.get(contig, 0), L)
            # Snapshot the final prefix of the difference array (positions
            # < avail never change again) and prefix-sum it.
            depth = array.array("i", itertools.accumulate(diff[:avail])) if avail > 0 else array.array("i")

        out = []
        blocks = ready and contig in self._blk_sum
        for i in range(n):
            lo, hi = edges[i], edges[i + 1]
            b = {"start": lo, "end": hi}
            lo_c, hi_c = max(lo, 0), min(hi, L)
            if hi_c <= lo_c:                       # entirely outside the contig
                b.update(value=0.0, max=0.0, min=0.0, cov=0)
            elif hi_c > avail:                     # not reached by the scan yet
                b.update(value=0.0, max=0.0, min=0.0, cov=0, pending=True)
            else:
                if blocks and hi_c - lo_c >= 4 * _BLOCK:
                    s, mx, mn = self._block_stats(contig, depth, lo_c, hi_c)
                else:
                    seg = depth[lo_c:hi_c]
                    s, mx, mn = sum(seg), max(seg), min(seg)
                b.update(value=s / (hi_c - lo_c), max=float(mx), min=float(mn), cov=hi_c - lo_c)
            out.append(b)
        return out

    # ── internals ───────────────────────────────────────────────────────

    def _block_stats(self, contig, depth, lo, hi):
        """Exact sum/max/min over [lo, hi) using 64-bp pre-aggregated blocks for
        the interior and per-base scans for the ragged ends."""
        b0 = -(-lo // _BLOCK)            # first block fully inside
        b1 = hi // _BLOCK                # one past the last block fully inside
        if b0 >= b1:                     # no full block inside
            seg = depth[lo:hi]
            return sum(seg), max(seg), min(seg)
        s = sum(self._blk_sum[contig][b0:b1])
        mx = max(self._blk_max[contig][b0:b1])
        mn = min(self._blk_min[contig][b0:b1])
        for seg in (depth[lo:b0 * _BLOCK], depth[b1 * _BLOCK:hi]):
            if seg:
                s += sum(seg)
                m1, m2 = max(seg), min(seg)
                if m1 > mx:
                    mx = m1
                if m2 < mn:
                    mn = m2
        return s, mx, mn

    def _run(self):
        try:
            self._scan()
            if self._cancel.is_set():
                self.state = "cancelled"
                self._diff = {}
                return
            for name, L in self._lengths.items():
                d = array.array("i", itertools.accumulate(self._diff[name][:L])) if L else array.array("i")
                self._depth[name] = d
                nb = -(-L // _BLOCK)
                sums, maxs, mins = array.array("q"), array.array("i"), array.array("i")
                for k in range(nb):
                    seg = d[k * _BLOCK:(k + 1) * _BLOCK]
                    sums.append(sum(seg)); maxs.append(max(seg)); mins.append(min(seg))
                self._blk_sum[name], self._blk_max[name], self._blk_min[name] = sums, maxs, mins
            self.progress = 1.0
            self.state = "ready"         # publish before freeing the build arrays
            self._diff = {}
        except Exception as e:                    # never let the thread die silently
            self.error = f"{type(e).__name__}: {e}"
            self._diff = {}
            self.state = "failed"
        finally:
            self._close_file()

    def _open(self):
        """Open the BAM stream and read its header: contig names/lengths and
        zeroed difference arrays. The stream is left positioned at the first
        alignment record for the background scan."""
        self._raw = open(self.path, "rb")
        f = self._gz = gzip.GzipFile(fileobj=self._raw, mode="rb")
        if f.read(4) != b"BAM\x01":
            raise ValueError("not a BAM file (bad magic)")
        l_text, = struct.unpack("<i", f.read(4))
        f.read(l_text)
        n_ref, = struct.unpack("<i", f.read(4))
        names, lens = [], []
        for _ in range(n_ref):
            l_name, = struct.unpack("<i", f.read(4))
            names.append(f.read(l_name)[:-1].decode("ascii", "replace"))
            L, = struct.unpack("<i", f.read(4))
            lens.append(max(0, L))
        if sum(lens) > MAX_INDEX_BP:
            raise IndexTooLarge(
                f"reference is {sum(lens):,} bp — larger than the {MAX_INDEX_BP:,} bp "
                f"exact-coverage index limit")
        self._names = names
        for name, L in zip(names, lens):
            self._diff[name] = array.array("i", bytes(4 * (L + 1)))
            self._final_upto[name] = 0
            self._lengths[name] = L   # last: has_contig() must not see a contig before its array

    def _close_file(self):
        for fh in (self._gz, self._raw):
            try:
                if fh is not None:
                    fh.close()
            except Exception:
                pass
        self._gz = self._raw = None

    def _scan(self):
        size = os.path.getsize(self.path) or 1
        raw, f, names = self._raw, self._gz, self._names
        lens = [self._lengths[n] for n in names]
        diffs = [self._diff[n] for n in names]
        spans = [0] * len(names)
        unpack_from = struct.unpack_from
        data = f.read(_CHUNK)
        off = 0
        cur_ref, last_pos, sorted_ok = -1, -1, True
        while True:
            avail = len(data) - off
            if avail < 4 or avail < 4 + unpack_from("<i", data, off)[0]:
                more = f.read(_CHUNK)
                if not more:
                    break
                data = data[off:] + more
                off = 0
                self.progress = min(0.999, raw.tell() / size)
                if cur_ref >= 0 and sorted_ok:
                    self._final_upto[names[cur_ref]] = max(0, last_pos)
                if self._cancel.is_set():
                    return
                continue
            bs = unpack_from("<i", data, off)[0]
            refid, pos, l_rn, _mq, _bin, n_cig, flag = unpack_from("<iiBBHHH", data, off + 4)
            if refid >= 0:
                if refid != cur_ref:
                    if refid < cur_ref:
                        sorted_ok = False
                    elif cur_ref >= 0 and sorted_ok:
                        self._final_upto[names[cur_ref]] = lens[cur_ref]
                    cur_ref, last_pos = refid, -1
                elif pos < last_pos:
                    sorted_ok = False
                if not sorted_ok and any(self._final_upto.values()):
                    # Not coordinate-sorted: nothing is final until the scan ends.
                    for name in names:
                        self._final_upto[name] = 0
                last_pos = pos
                if n_cig and not (flag & 0x4):
                    count = not (flag & SKIP_FLAGS)
                    d = diffs[refid]
                    L = lens[refid]
                    p = pos
                    for c in unpack_from("<%dI" % n_cig, data, off + 36 + l_rn):
                        op = c & 0xF
                        if op == 0 or op == 7 or op == 8:      # M = X: aligned bases
                            e = p + (c >> 4)
                            if count and p < L and e > 0:
                                d[p if p > 0 else 0] += 1
                                d[e if e < L else L] -= 1
                            p = e
                        elif op == 2 or op == 3:                # D N: skip reference
                            p += c >> 4
                    if p - pos > spans[refid]:
                        spans[refid] = p - pos
            off += 4 + bs
        if sorted_ok:
            for name, L in zip(names, lens):
                self._final_upto[name] = L
        self._max_span = {name: spans[i] for i, name in enumerate(names)}
