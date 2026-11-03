"""
Exact per-base read depth for a BAM, built once in the background.

Zoomed-out coverage used to be computed live by iterating reads through
bamnostic (~25k reads/s) with a 500k-read cap, so on a deep ChIP BAM the
whole-chromosome view showed coverage for the first few kb and zeros after.
Instead the BAM is streamed once by a minimal BGZF/BAM record scanner
(zlib + struct — pure Python, ~600k reads/s), accumulating a per-base depth
difference array per contig; every coverage query is then answered exactly
(mean / max / min depth per bin) at any zoom.

The scan runs in a child process: this file run as a script, which needs
only the standard library. It is CPU-bound Python, and in a thread of the
server it held the interpreter lock for most of the build, so every request
answered meanwhile (the read view, other tracks, the heartbeat) waited for it
again and again. The child sends the server the depth it has finished, as
runs of int32 values over a pipe (see _MSG); the server keeps one depth array
per contig and answers queries from it. Where no child process can be
started, the same build runs in a thread.

Counting rules match IGV's defaults, so coverage agrees with the read pileup:
reads flagged unmapped (0x4), QC-fail (0x200) or duplicate (0x400) are
skipped (secondary/supplementary alignments count), and only aligned bases
(CIGAR M/=/X) count — deletions and introns (D/N) do not. A CIGAR of more
than 65,535 operations is stored in the CG tag behind a placeholder; the
real one is used, as htslib and bamnostic do.

While the scan is running, positions it has already passed are final if the
header declares the BAM coordinate-sorted (@HD SO:coordinate): the child
sends their depth as it goes, so queries are answered exactly up to that
point and the remaining bins are returned with ``pending: True``. Without
that declaration every bin stays pending until the scan has finished.

A record whose block_size contradicts its fixed-size fields (htslib's check),
or a file that ends inside a record, fails the build instead of being skipped
or miscounted; BamReader then falls back to its live pileup.
"""

import array
import itertools
import os
import struct
import subprocess
import sys
import threading
import zlib
from pathlib import Path

SKIP_FLAGS = 0x4 | 0x200 | 0x400           # unmapped | QC-fail | duplicate (IGV defaults)
_CHUNK = 1 << 22                            # uncompressed bytes per read() of the stream
_RAW_CHUNK = 1 << 22                        # compressed bytes per read() of the file
_BLOCK = 64                                 # bp per pre-aggregated block for fast zoomed-out queries
# The start of every alignment record: block_size, refID, pos, l_read_name,
# mapq, bin, n_cigar_op, flag, l_seq. With next_refID, next_pos and tlen the
# fixed part is 36 bytes, block_size included.
_RECORD = struct.Struct("<iiiBBHHHi")
_MAX_RECORD = 1 << 28                       # bytes; a larger block_size is corrupt
# Size in bytes of each fixed-size SAM aux value type (A c C s S i I f).
_AUX_SIZE = {ord(t): n for t, n in zip("AcCsSiIf", (1, 1, 1, 2, 2, 4, 4, 4))}
# The build holds the difference array (int32 per reference base) and, at the
# end, one contig's depth; the server holds the depth. Cap the reference at
# genome sizes this viewer targets; larger ones fall back to the live
# (bounded) pileup.
MAX_INDEX_BP = 32_000_000

# A message from the build to the server: kind, contig index, a, b, then for
# some kinds a payload.
#   P  progress: a of the file's b compressed bytes read
#   D  depth: positions a .. a+b-1 of contig ci are final; b int32 values
#   W  withdraw: the records turned out to be out of coordinate order, so no
#      position is final until the scan has finished
#   B  blocks: contig ci's a 64-bp block sums (int64), then maxima and
#      minima (int32 each)
#   E  error: b bytes of UTF-8 text
#   F  finished: every contig's depth and blocks have been sent
_MSG = struct.Struct("<cIqq")
_SEND_VALUES = 1 << 21                      # int32 values per D message (8 MiB)


class IndexTooLarge(Exception):
    pass


class _BgzfReader:
    """Sequential reader of a BGZF file's uncompressed stream.

    The file is read in large chunks and each BGZF block is inflated, and its
    CRC32 and size checked, by a single zlib call: one GIL release per block.
    gzip.GzipFile released it two or more times per block (inflate, CRC, file
    reads), and while another Python thread is busy every release costs the
    scan a switch interval or more, so the background build crawled whenever
    requests were being served. A file that ends after a complete block,
    without the EOF marker block, just ends the stream; one that ends inside
    a block raises EOFError."""

    def __init__(self, raw):
        self._raw = raw
        self._buf = b""          # compressed bytes read from the file
        self._pos = 0            # offset of the next block in _buf
        self._out = b""          # inflated bytes not yet returned by read()
        self.offset = 0          # compressed bytes consumed so far

    def read(self, n: int) -> bytes:
        """The next ``n`` uncompressed bytes (fewer only at the end of the file)."""
        out = self._out
        if len(out) >= n:
            self._out = out[n:]
            return out[:n]
        parts, have = [out], len(out)
        while have < n:
            block = self._block()
            if block is None:
                break
            parts.append(block)
            have += len(block)
        data = b"".join(parts)
        self._out = data[n:]
        return data[:n] if have > n else data

    def _fill(self, need: int):
        """At least ``need`` compressed bytes from the next block on (fewer
        only at the end of the file)."""
        rest = self._buf[self._pos:]
        parts, have = [rest], len(rest)
        while have < need:
            more = self._raw.read(max(_RAW_CHUNK, need - have))
            if not more:
                break
            parts.append(more)
            have += len(more)
        self._buf, self._pos = b"".join(parts), 0
        return self._buf, 0

    def _block(self):
        """Inflate the next BGZF block; None at the end of the file."""
        buf, p = self._buf, self._pos
        if len(buf) - p < 18:
            buf, p = self._fill(18)
            if len(buf) - p < 18:
                if len(buf) == p:
                    return None
                raise EOFError("BAM file ends inside a BGZF block")
        if buf[p] != 31 or buf[p + 1] != 139 or buf[p + 2] != 8 or not buf[p + 3] & 4:
            raise ValueError("not a BGZF file (bad block header)")
        xlen = buf[p + 10] | buf[p + 11] << 8
        if len(buf) - p < 12 + xlen:
            buf, p = self._fill(12 + xlen)
            if len(buf) - p < 12 + xlen:
                raise EOFError("BAM file ends inside a BGZF block")
        # The total block size - 1 is in the 'BC' extra subfield.
        bsize, q, xend = 0, p + 12, p + 12 + xlen
        while q + 6 <= xend:
            slen = buf[q + 2] | buf[q + 3] << 8
            if buf[q] == 66 and buf[q + 1] == 67 and slen == 2:
                bsize = (buf[q + 4] | buf[q + 5] << 8) + 1
                break
            q += 4 + slen
        if bsize < 12 + xlen + 8:
            raise ValueError("not a BGZF file (no block size)")
        if len(buf) - p < bsize:
            buf, p = self._fill(bsize)
            if len(buf) - p < bsize:
                raise EOFError("BAM file ends inside a BGZF block")
        isize = struct.unpack_from("<I", buf, p + bsize - 4)[0]
        if isize > 65536:                # BGZF blocks hold at most 64 KiB
            raise ValueError("corrupt BGZF block (bad uncompressed size)")
        # wbits 31: zlib parses the gzip header and verifies the CRC32/ISIZE
        # trailer itself. An output buffer one byte larger than the block
        # makes it a single inflate() call (one GIL release).
        data = zlib.decompress(memoryview(buf)[p:p + bsize], 31, isize + 1)
        self._pos = p + bsize
        self.offset += bsize
        return data


def _declares_coordinate_order(text: bytes) -> bool:
    """True when the SAM header text has an @HD line with SO:coordinate."""
    for line in text.split(b"\n"):
        if line.startswith(b"@HD"):
            return any(f.strip(b"\r\0 ") == b"SO:coordinate" for f in line.split(b"\t"))
    return False


def _real_cigar(data, off, bs, l_rn, cig):
    """The CIGAR of the record at ``off`` (block size ``bs``, name length
    ``l_rn``) whose stored two-op CIGAR ``cig`` is S then N. That is the
    placeholder for a CIGAR of more than 65,535 operations when the S length
    equals the read length: the real CIGAR is in the CG:B:I aux tag. Returns
    ``cig`` itself when the record is not such a placeholder or has no
    usable CG tag."""
    l_seq = struct.unpack_from("<i", data, off + 20)[0]
    if cig[0] >> 4 != l_seq:
        return cig
    end = off + 4 + bs
    # The aux tags follow the read name, the CIGAR, SEQ and QUAL.
    p = off + 36 + l_rn + 8 + (l_seq + 1) // 2 + l_seq
    while p + 3 <= end:
        typ = data[p + 2]
        if typ == 66:                                   # 'B': sub-type, count, values
            if p + 8 > end:
                break
            sub = data[p + 3]
            n = struct.unpack_from("<i", data, p + 4)[0]
            size = _AUX_SIZE.get(sub)
            if size is None or n < 0:
                break
            if data[p] == 67 and data[p + 1] == 71 and (sub == 73 or sub == 105):   # CG:B:I / CG:B:i
                if p + 8 + 4 * n <= end:
                    return struct.unpack_from("<%dI" % n, data, p + 8)
                break
            p += 8 + size * n
        elif typ == 90 or typ == 72:                    # 'Z' / 'H': NUL-terminated
            q = data.find(b"\0", p + 3, end)
            if q < 0:
                break
            p = q + 1
        else:
            size = _AUX_SIZE.get(typ)
            if size is None:
                break
            p += 3 + size
    return cig


def _read_header(f) -> tuple:
    """(declares coordinate order, contig names, contig lengths) from the
    start of a BAM stream, which is left at the first alignment record.
    Raises IndexTooLarge for a reference larger than MAX_INDEX_BP."""
    if f.read(4) != b"BAM\x01":
        raise ValueError("not a BAM file (bad magic)")
    l_text, = struct.unpack("<i", f.read(4))
    if l_text < 0:
        raise ValueError("not a BAM file (bad header length)")
    coord_sorted = _declares_coordinate_order(f.read(l_text))
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
    return coord_sorted, names, lens


# ── The build (child process, or a thread) ──────────────────────────────


class _Gone(Exception):
    """The server stopped listening (it exited, or cancelled the build)."""


class _Sender:
    """The build's end of the pipe: _MSG messages written to ``out``."""

    def __init__(self, out, cancel=None):
        self._out = out
        self._cancel = cancel             # threading.Event of an in-process build

    def send(self, kind: bytes, ci: int = 0, a: int = 0, b: int = 0, payload=b""):
        if self._cancel is not None and self._cancel.is_set():
            raise _Gone()
        try:
            self._out.write(_MSG.pack(kind, ci, a, b))
            if len(payload):
                self._out.write(payload)
        except OSError as e:              # BrokenPipeError, or EINVAL on Windows
            raise _Gone() from e

    def flush(self):
        try:
            self._out.flush()
        except OSError as e:
            raise _Gone() from e


class _Depth:
    """The build's per-contig difference arrays, and how much of each
    contig's depth has been sent."""

    def __init__(self, lens: list, send: _Sender, live: bool):
        self.lens = lens
        self.diffs = [array.array("i", bytes(4 * (L + 1))) for L in lens]
        self.live = live                  # send depth as positions become final
        self.sent = [0] * len(lens)       # depth of positions < sent[ci] was sent
        self.run = [0] * len(lens)        # depth at sent[ci] - 1
        self.send = send

    def publish(self, ci: int, upto: int):
        """Send the depth of contig ``ci`` below ``upto``: in a coordinate-
        sorted BAM no later record starts there, so no later record changes it."""
        s, upto = self.sent[ci], min(upto, self.lens[ci])
        if not self.live or upto <= s:
            return
        acc = itertools.accumulate(self.diffs[ci][s:upto], initial=self.run[ci])
        next(acc)                          # the initial value itself
        vals = array.array("i", acc)
        self.run[ci], self.sent[ci] = vals[-1], upto
        self._send_depth(ci, s, vals)

    def withdraw(self):
        """Records out of order after all: nothing is final until the end."""
        self.live = False
        self.sent = [0] * len(self.lens)
        self.run = [0] * len(self.lens)
        self.send.send(b"W")

    def finish(self):
        """After the last record: the rest of every contig's depth, and its
        64-bp block statistics; then F."""
        for ci, L in enumerate(self.lens):
            d = array.array("i", itertools.accumulate(self.diffs[ci][:L])) if L else array.array("i")
            self.diffs[ci] = None          # freed as the build goes
            s = self.sent[ci]
            if L > s:
                self._send_depth(ci, s, d, s)
            sums, maxs, mins = _blocks(d)
            self.send.send(b"B", ci, len(sums), 0, sums.tobytes() + maxs.tobytes() + mins.tobytes())
        self.send.send(b"F")
        self.send.flush()

    def _send_depth(self, ci: int, start: int, vals, skip: int = 0):
        """Send ``vals[skip:]`` as the depth of contig ``ci`` from ``start`` on."""
        raw = memoryview(vals).cast("B")
        for k in range(skip, len(vals), _SEND_VALUES):
            n = min(_SEND_VALUES, len(vals) - k)
            self.send.send(b"D", ci, start + k - skip, n, raw[4 * k:4 * (k + n)])
        self.send.flush()


def _blocks(d) -> tuple:
    """Sums, maxima and minima of ``d`` per _BLOCK-bp block."""
    sums, maxs, mins = array.array("q"), array.array("i"), array.array("i")
    for k in range(-(-len(d) // _BLOCK)):
        seg = d[k * _BLOCK:(k + 1) * _BLOCK]
        sums.append(sum(seg)); maxs.append(max(seg)); mins.append(min(seg))
    return sums, maxs, mins


def _scan(f, size: int, depth: _Depth, send: _Sender):
    """Count the aligned bases of every record from the stream ``f`` (just
    past the header) into ``depth``, sending the depth that is final as the
    scan goes when the header declares coordinate order. Records out of
    order despite that (a stale or mismatched file) withdraw it again until
    the scan has finished."""
    lens, diffs = depth.lens, depth.diffs
    unpack_from = struct.unpack_from
    record = _RECORD.unpack_from
    unsorted = False
    data = f.read(_CHUNK)
    have = len(data)
    off = 0
    cur_ref, last_pos = -1, -1
    while True:
        avail = have - off
        if avail >= 36:
            bs, refid, pos, l_rn, _mq, _bin, n_cig, flag, l_seq = record(data, off)
        if avail < 36 or avail < 4 + bs:
            # The next record is not all in the buffer: read on.
            if avail >= 36 and bs > _MAX_RECORD:
                raise ValueError("malformed alignment record")
            more = f.read(_CHUNK)
            if not more:
                if avail:
                    raise EOFError("the BAM ends inside an alignment record")
                break
            data = data[off:] + more
            have = len(data)
            off = 0
            if cur_ref >= 0:
                depth.publish(cur_ref, max(0, last_pos))
            send.send(b"P", 0, f.offset, size)
            send.flush()
            continue
        # The fixed-size fields must fit in the record (htslib's check):
        # a wrong block_size would stall the scan, move it backwards or
        # lose its place among the records.
        if bs < 32 + l_rn + 4 * n_cig + ((l_seq + 1) >> 1) + l_seq or l_seq < 0 or not l_rn:
            raise ValueError("malformed alignment record")
        if refid >= 0:
            if refid != cur_ref:
                if refid < cur_ref:
                    unsorted = True
                else:
                    # Contigs before this one get no more records.
                    for k in range(max(cur_ref, 0), refid):
                        depth.publish(k, lens[k])
                cur_ref, last_pos = refid, -1
            elif pos < last_pos:
                unsorted = True
            if unsorted and depth.live:
                depth.withdraw()
            last_pos = pos
            if n_cig and not (flag & SKIP_FLAGS):
                d = diffs[refid]
                L = lens[refid]
                p = pos
                cig = unpack_from("<%dI" % n_cig, data, off + 36 + l_rn)
                if n_cig == 2 and cig[0] & 0xF == 4 and cig[1] & 0xF == 3:
                    cig = _real_cigar(data, off, bs, l_rn, cig)   # CIGAR kept in the CG tag
                for c in cig:
                    op = c & 0xF
                    if op == 0 or op == 7 or op == 8:      # M = X: aligned bases
                        e = p + (c >> 4)
                        if p < L and e > 0:
                            d[p if p > 0 else 0] += 1
                            d[e if e < L else L] -= 1
                        p = e
                    elif op == 2 or op == 3:                # D N: skip reference
                        p += c >> 4
        off += 4 + bs


def _build(path: str, out, cancel=None):
    """Build the depth of the BAM at ``path``, sending it to ``out`` (a
    binary file) as _MSG messages. ``cancel``: the Event of a build that
    runs in a thread of the server."""
    send = _Sender(out, cancel)
    try:
        try:
            size = os.path.getsize(path) or 1
            with open(path, "rb") as raw:
                f = _BgzfReader(raw)
                coord_sorted, _names, lens = _read_header(f)
                depth = _Depth(lens, send, coord_sorted)
                _scan(f, size, depth, send)
            depth.finish()
        except _Gone:
            raise
        except Exception as e:
            msg = f"{type(e).__name__}: {e}".encode("utf-8", "replace")
            send.send(b"E", 0, 0, len(msg), msg)
            send.flush()
    except _Gone:
        pass                               # nobody is listening any more


def _build_in_thread(path: str, out, cancel):
    try:
        _build(path, out, cancel)
    finally:
        try:
            out.close()
        except OSError:
            pass


def _child_command(path: str) -> list:
    """The command line of a build process: this file, run by the server's
    own Python (python.exe rather than pythonw.exe, which may have no
    usable standard output) in isolated mode, standard library only."""
    exe = sys.executable
    if not exe:
        raise OSError("no Python executable to run the coverage build")
    p = Path(exe)
    if p.name.lower() == "pythonw.exe" and (p.parent / "python.exe").exists():
        exe = str(p.parent / "python.exe")
    return [exe, "-I", "-B", str(Path(__file__).resolve()), path]


# Never a console window of its own, and a lower priority than the server.
_CHILD_FLAGS = ({"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS}
                if sys.platform == "win32" else {})


def _read_exact(stream, n: int) -> bytes:
    data = stream.read(n)
    if len(data) != n:
        raise EOFError("the coverage build stopped mid-message")
    return data


# ── The server's side ────────────────────────────────────────────────────


class BamCoverageIndex:
    """Exact depth for every contig of one BAM file, built in the background."""

    def __init__(self, path: str, start: bool = True):
        self.path = str(path)
        self.state = "building"          # building | ready | failed | unsupported | cancelled
        self.error: str | None = None
        self.progress = 0.0              # fraction of the compressed file consumed
        self._lengths: dict[str, int] = {}
        self._depth: dict[str, array.array] = {}   # per base; final below _final_upto
        self._blk_sum: dict[str, array.array] = {}
        self._blk_max: dict[str, array.array] = {}
        self._blk_min: dict[str, array.array] = {}
        self._final_upto: dict[str, int] = {}   # positions < value are final
        self._names: list[str] = []
        self._coord_sorted = False              # header declares @HD SO:coordinate
        self._proc = None                # the build process, or None for a build in a thread
        self._stream = None              # its messages
        self._cancel = threading.Event()
        self.in_process = False          # True when the build runs in a thread of the server
        self._thread = threading.Thread(target=self._receive, daemon=True,
                                        name=f"bam-coverage:{Path(self.path).name}")
        # Read the header here (milliseconds) so contigs are known the moment
        # the track exists; only the record scan runs in the background.
        try:
            self._open()
        except IndexTooLarge as e:
            self.error, self.state, start = str(e), "unsupported", False
        except Exception as e:
            self.error, self.state, start = f"{type(e).__name__}: {e}", "failed", False
        if start:
            self._start()

    # ── public ──────────────────────────────────────────────────────────

    def cancel(self):
        self._cancel.set()
        proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass

    def wait(self, timeout=None) -> bool:
        if self._thread.ident is None:   # never started
            return True
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def status(self) -> dict:
        return {"state": self.state, "progress": round(self.progress, 4), "error": self.error}

    def has_contig(self, name: str) -> bool:
        return name in self._lengths

    def coverage(self, contig: str, start: int, end: int, bins: int) -> tuple[list[dict], str]:
        """Bins over [start, end): exact mean / max / min depth per bin, and
        the state they were computed under.

        Bin edges are the integer coordinates reported to the client, so the
        statistics describe exactly the bases each bar is drawn over. Bins past
        the contig end are empty (value 0, ``cov`` 0). While the background scan
        is still running, bins it has not reached are returned with
        ``pending: True`` and zero values; such an answer comes with state
        'building' even if the build has ended (or failed) since, so it is
        never taken for final. 'ready' means the bins come from the finished
        index; any other state comes with no bins (nothing usable)."""
        state = self.state
        region_len = end - start
        if region_len <= 0 or contig not in self._lengths:
            return [], state
        L = self._lengths[contig]
        n = min(bins, region_len)
        bs = region_len / n
        edges = [start + int(i * bs) for i in range(n)] + [end]

        if state == "ready":
            avail = L
        elif state == "building":
            avail = min(self._final_upto.get(contig, 0), L)
        else:                            # failed / cancelled: nothing usable
            return [], state
        depth = self._depth.get(contig)
        if depth is None:                # the build ended (failed) between the reads
            return [], self.state

        out = []
        blocks = state == "ready" and contig in self._blk_sum
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
        return out, state

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

    def _open(self):
        """Read the header: contig names and lengths and whether it declares
        coordinate order; and make the (zeroed) depth arrays."""
        with open(self.path, "rb") as raw:
            self._coord_sorted, names, lens = _read_header(_BgzfReader(raw))
        self._names = names
        for name, L in zip(names, lens):
            self._depth[name] = array.array("i", bytes(4 * L))
            self._final_upto[name] = 0
            self._lengths[name] = L   # last: has_contig() must not see a contig before its array

    def _start(self, in_process: bool = False):
        """Start the build: in a child process, or (where none can be
        started) in a thread; then the thread that receives its messages."""
        if not in_process:
            try:
                self._proc = subprocess.Popen(
                    _child_command(self.path), stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **_CHILD_FLAGS)
                self._stream = self._proc.stdout
            except (OSError, ValueError, subprocess.SubprocessError):
                in_process = True
        if in_process:
            self._proc = None
            self.in_process = True
            r, w = os.pipe()
            self._stream = os.fdopen(r, "rb")
            threading.Thread(target=_build_in_thread, args=(self.path, os.fdopen(w, "wb"), self._cancel),
                             daemon=True, name=f"bam-coverage-build:{Path(self.path).name}").start()
        if self._thread.ident is None:
            self._thread.start()

    def _receive(self):
        """Apply the build's messages until it has finished, failed or been
        cancelled. A build process that ends before its first message (it
        could not run at all) is replaced by a build in a thread."""
        may_restart = True
        while True:
            stream, proc = self._stream, self._proc
            try:
                self._apply_messages(stream, may_restart and proc is not None)
            except _Restart:
                may_restart = False
                self._close(stream, proc)
                self._start(in_process=True)
                continue
            except Exception as e:
                if self._cancel.is_set():
                    self.state = "cancelled"
                else:
                    code = proc.poll() if proc is not None else None
                    self.error = str(e) if isinstance(e, _BuildError) else (
                        f"{type(e).__name__}: {e}" + (f" (build process exit code {code})" if code else ""))
                    self.state = "failed"
                self._depth = {}
                self._blk_sum, self._blk_max, self._blk_min = {}, {}, {}
                self._close(stream, proc)
                return
            self._close(stream, proc)
            return

    def _apply_messages(self, stream, may_restart: bool):
        """Read and apply messages up to F (state 'ready'). Raises _Restart
        when ``may_restart`` and the stream ends before any message."""
        size = _MSG.size
        while True:
            head = stream.read(size)
            if len(head) < size:
                if may_restart and not head and not self._cancel.is_set():
                    raise _Restart()
                raise EOFError("the coverage build stopped unexpectedly")
            may_restart = False
            kind, ci, a, b = _MSG.unpack(head)
            if kind == b"P":
                self.progress = min(0.999, a / b) if b else 0.0
            elif kind == b"D":
                vals = array.array("i")
                vals.frombytes(_read_exact(stream, 4 * b))
                name = self._names[ci]
                self._depth[name][a:a + b] = vals
                self._final_upto[name] = a + b    # after the values: never ahead of them
            elif kind == b"W":
                for name in self._names:
                    self._final_upto[name] = 0
            elif kind == b"B":
                raw = _read_exact(stream, 16 * a)
                sums, maxs, mins = array.array("q"), array.array("i"), array.array("i")
                sums.frombytes(raw[:8 * a])
                maxs.frombytes(raw[8 * a:12 * a])
                mins.frombytes(raw[12 * a:])
                name = self._names[ci]
                self._blk_sum[name], self._blk_max[name], self._blk_min[name] = sums, maxs, mins
            elif kind == b"E":
                raise _BuildError(_read_exact(stream, b).decode("utf-8", "replace"))
            elif kind == b"F":
                self.progress = 1.0
                for name, L in self._lengths.items():
                    self._final_upto[name] = L
                self.state = "ready"
                return
            else:
                raise ValueError(f"unexpected coverage build message {kind!r}")

    @staticmethod
    def _close(stream, proc):
        """Close the message stream and reap the build process (killing it
        when it does not exit by itself: cancelled, or failed)."""
        try:
            if stream is not None:
                stream.close()
        except OSError:
            pass
        if proc is not None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass


class _BuildError(Exception):
    """The build reported an error (its own message)."""


class _Restart(Exception):
    """The build process ended before saying anything: run it in a thread."""


if __name__ == "__main__":
    # A build process (BamCoverageIndex._start): the BAM's path is the argument.
    if hasattr(os, "nice"):
        try:
            os.nice(5)
        except OSError:
            pass
    _build(sys.argv[1], sys.stdout.buffer)
