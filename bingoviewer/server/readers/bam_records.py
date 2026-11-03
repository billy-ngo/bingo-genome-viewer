"""
Raw, read-only access to the alignment records of an indexed BAM, for the
read view. Pure Python (struct + zlib), like the record scanner in
bam_coverage.py.

bamnostic's fetch() was both slow and loose for the pileup: it decodes every
record in full (SEQ, QUAL and the CIGAR walked base by base, ~12k reads/s),
and it decides overlap from pos + len(SEQ), so alignments that span more
reference than their sequence (long reads with deletions or introns,
alignments stored without SEQ) were missed when they started left of the
window. Here a region is answered the way htslib answers it: the chunks of
every BAI bin that can hold an alignment overlapping the window, minus the
chunks that end before the linear-index offset of the window start. That
finds every overlapping alignment, however far left it starts, with no
lookback. Records are parsed only as far as each step needs: the fixed fields
(plus the CIGAR for reads that start left of the window) to test overlap, and
the whole record only for the reads that are returned. A record's block_size
is checked as soon as it is read, so a corrupt one fails at once instead of
making the scan inflate the rest of the file in search of the record's end.
"""

import struct
import zlib
from array import array

_BAI_MAGIC = b"BAI\x01"
_BGZF_MAGIC = b"\x1f\x8b\x08\x04"
_LINEAR_SHIFT = 14              # the BAI linear index has one offset per 16 kb window
_MAX_BAI_POS = 1 << 29          # a BAI indexes coordinates below 2^29
_REF_OPS = 0b110001101          # CIGAR ops that consume reference: M(0) D(2) N(3) =(7) X(8)
_CIGAR_CHARS = "MIDNSHP=X"
_NT16 = b"=ACMGRSVTWYHKDBN"     # BAM 4-bit base codes
_SEQ_HI = bytes(_NT16[b >> 4] for b in range(256))
_SEQ_LO = bytes(_NT16[b & 0xF] for b in range(256))
_AUX_SIZE = {ord(t): n for t, n in (("A", 1), ("c", 1), ("C", 1), ("s", 2), ("S", 2),
                                     ("i", 4), ("I", 4), ("f", 4))}
_FILE_BUFFER = 1 << 18          # consecutive BGZF blocks are served from this read buffer
_KEEP_BYTES = 64 << 20          # records kept from a scan (decoded without re-reading the file)
_POLL_BLOCKS = 16               # call is_current() every this many inflated blocks (~1 MB)
_MAX_RECORD = 1 << 28           # a block_size above this (256 MiB) is corrupt, not a read
_NO_LIMIT = float("inf")
_FIXED = struct.Struct("<iiiBBHHHi").unpack_from   # block_size and the fixed fields
_WORD = struct.Struct("<I").unpack_from
_SHORT_CIGAR = 32               # scanning sums the CIGARs with fewer operations inline
_CIGAR_WORDS = [struct.Struct("<%dI" % k).unpack_from for k in range(_SHORT_CIGAR)]


def reg2bins(beg: int, end: int) -> list[int]:
    """BAI bins that may hold an alignment overlapping [beg, end) (SAM spec 5.3)."""
    end -= 1
    bins = [0]
    for shift, first in ((26, 1), (23, 9), (20, 73), (17, 585), (14, 4681)):
        bins.extend(range(first + (beg >> shift), first + (end >> shift) + 1))
    return bins


class BaiIndex:
    """A BAM's .bai, read on first use; a reference's bins are decoded the
    first time that reference is queried."""

    def __init__(self, path: str):
        self.path = path
        self._data = None
        self._ref_at: list[int] = []   # byte offset of each reference's section
        self._refs: dict[int, tuple] = {}

    def _load(self):
        with open(self.path, "rb") as fh:
            data = fh.read()
        if data[:4] != _BAI_MAGIC:
            raise ValueError("not a BAI index")
        unpack_from = struct.unpack_from
        n_ref, = unpack_from("<i", data, 4)
        at, p = [], 8
        for _ in range(n_ref):
            at.append(p)
            n_bin, = unpack_from("<i", data, p)
            p += 4
            for _ in range(n_bin):
                p += 8 + 16 * unpack_from("<i", data, p + 4)[0]
            p += 4 + 8 * unpack_from("<i", data, p)[0]
        if p > len(data):
            raise ValueError("truncated BAI index")
        self._data, self._ref_at = data, at

    def _ref(self, tid: int) -> tuple:
        """({bin: [(start, end) virtual offsets]}, linear index) of one reference."""
        ref = self._refs.get(tid)
        if ref is None:
            data, p, unpack_from = self._data, self._ref_at[tid], struct.unpack_from
            bins = {}
            n_bin, = unpack_from("<i", data, p)
            p += 4
            for _ in range(n_bin):
                b, n_chunk = unpack_from("<Ii", data, p)
                flat = unpack_from("<%dQ" % (2 * n_chunk), data, p + 8)
                bins[b] = list(zip(flat[::2], flat[1::2]))
                p += 8 + 16 * n_chunk
            n_intv, = unpack_from("<i", data, p)
            ref = self._refs[tid] = (bins, unpack_from("<%dQ" % n_intv, data, p + 4))
        return ref

    def chunks(self, tid: int, beg: int, end: int) -> list[tuple[int, int]]:
        """Sorted (start, end) virtual-offset ranges of reference ``tid`` that
        hold every alignment overlapping [beg, end); [] when there is none.

        As htslib's hts_itr_query: the chunks of all bins from reg2bins(beg,
        end) that end after the linear-index offset of beg's 16 kb window (the
        first record of any alignment reaching that window), clipped to it;
        contained chunks dropped and chunks that meet in one BGZF block
        merged."""
        if self._data is None:
            self._load()
        if not 0 <= tid < len(self._ref_at):
            return []
        bins, lin = self._ref(tid)
        beg, end = max(0, beg), min(end, _MAX_BAI_POS)
        if not bins or end <= beg:
            return []
        w = beg >> _LINEAR_SHIFT
        # Past the last linear window nothing can overlap, but stay
        # conservative (as htslib does) and start from the last offset.
        min_off = lin[w] if w < len(lin) else (lin[-1] if lin else 0)
        found = [(max(u, min_off), v)
                 for b in reg2bins(beg, end) for u, v in bins.get(b, ()) if v > min_off]
        if not found:
            return []
        found.sort()
        out = [list(found[0])]
        for u, v in found[1:]:
            last = out[-1]
            if v <= last[1]:
                continue                  # contained in the previous chunk
            if last[1] > u:
                last[1] = u               # overlap left by the indexer's own merging
            if last[1] >> 16 == u >> 16:
                last[1] = v               # they meet in one BGZF block: read through
            else:
                out.append([u, v])
        return [(u, v) for u, v in out]


class _Blocks:
    """Inflated BGZF blocks of an open BAM by compressed offset (CRC and size
    checked), the last few cached."""

    def __init__(self, fh, keep: int = 4):
        self._fh = fh
        self._keep = keep
        self._cache: dict[int, tuple[bytes, int]] = {}
        self.inflated = 0

    def get(self, coffset: int) -> tuple[bytes, int]:
        """(data, offset of the next block) of the block at ``coffset``."""
        hit = self._cache.get(coffset)
        if hit is not None:
            return hit
        fh = self._fh
        fh.seek(coffset)
        head = fh.read(18)
        if len(head) < 18:
            raise EOFError("the BAM ends before an indexed block")
        if head[:4] != _BGZF_MAGIC:
            raise ValueError("malformed BGZF block")
        xlen = head[10] | head[11] << 8
        if xlen == 6 and head[12:16] == b"BC\x02\x00":
            bsize = head[16] | head[17] << 8
            rest = fh.read(bsize - 17)
            want = bsize - 17
        else:                             # other extra subfields besides BC
            if xlen < 6:
                raise ValueError("malformed BGZF block")
            extra = head[12:] + fh.read(xlen - 6)
            p, bsize = 0, None
            while p + 4 <= len(extra):
                slen = extra[p + 2] | extra[p + 3] << 8
                if extra[p:p + 2] == b"BC" and slen == 2 and p + 6 <= len(extra):
                    bsize = extra[p + 4] | extra[p + 5] << 8
                p += 4 + slen
            if bsize is None:
                raise ValueError("malformed BGZF block")
            want = bsize + 1 - 12 - xlen
            rest = fh.read(want)
        if want < 8 or len(rest) != want:
            raise EOFError("the BAM ends inside a BGZF block")
        crc, isize = struct.unpack_from("<II", rest, want - 8)
        data = zlib.decompress(memoryview(rest)[:-8], -15)
        if len(data) != isize or zlib.crc32(data) != crc:
            raise ValueError("BGZF block fails its integrity check")
        self.inflated += 1
        hit = (data, coffset + bsize + 1)
        cache = self._cache
        if len(cache) >= self._keep:
            del cache[next(iter(cache))]
        cache[coffset] = hit
        return hit


class RegionScan:
    """What BamRecords.scan() found. Per overlapping alignment, in file
    order: its virtual offset, start and sampling key; plus the records
    themselves (bytes) when there were few enough to keep."""

    __slots__ = ("vofs", "starts", "keys", "records", "examined", "leading", "complete",
                 "scanned_to", "cancelled")

    def __init__(self):
        self.vofs = array("Q")
        self.starts = array("q")
        self.keys = array("I")
        self.records: list[bytes] | None = None
        self.examined = 0         # records parsed, of any kind
        self.leading = 0          # of them, records starting left of the window
        self.complete = True      # False: a record budget ran out before the window end
        self.scanned_to = None    # then where: every overlapping record starting before it was found
        self.cancelled = False    # True: is_current() returned False; nothing else is valid


class BamRecords:
    """Region queries over one indexed BAM. Each query opens its own file
    handle; queries on one instance must not overlap (the caller holds the
    track lock, as for every reader)."""

    def __init__(self, bam_path: str, bai_path: str):
        self.bam_path = bam_path
        self.index = BaiIndex(bai_path)

    def scan(self, tid: int, beg: int, end: int, skip_flags: int, is_current=None,
             max_records: int | None = None, max_leading: int | None = None,
             keep: int = 0) -> RegionScan:
        """Find every alignment of reference ``tid`` overlapping [beg, end) that
        has none of ``skip_flags``. Overlap uses the true reference end
        (pos + the M/D/N/=/X lengths of the CIGAR, or of the CG tag behind a
        kSmN placeholder; pos + 1 without a CIGAR). The records themselves are
        kept while there are at most ``keep`` of them.

        The chunks start at the first record reaching beg's 16 kb window, so
        the scan also passes over the records that start left of beg (up to
        16 kb of them, plus long reads), most of which end before it. Two
        budgets bound it, each counting records of any kind: ``max_records``
        starting at or after beg and ``max_leading`` starting before it. At
        the first record past either, the scan stops with ``complete`` False
        and ``scanned_to`` that record's position: every overlapping
        alignment that starts before it was found (scanned_to < beg: the
        window was not reached)."""
        res = RegionScan()
        chunks = self.index.chunks(tid, beg, end)
        if not chunks:
            return res
        vofs, starts, keys = res.vofs, res.starts, res.keys
        records = [] if keep else None
        kept_bytes = 0
        limit = _NO_LIMIT if max_records is None else max_records
        lead_limit = _NO_LIMIT if max_leading is None else max_leading
        unpack_from, fixed, word, crc32 = struct.unpack_from, _FIXED, _WORD, zlib.crc32
        seen = lead = polled = 0
        with open(self.bam_path, "rb", buffering=_FILE_BUFFER) as fh:
            blocks = _Blocks(fh)
            done = False
            for u, v in chunks:
                vblk, vu = v >> 16, v & 0xFFFF
                # The buffer ``data`` holds block ``seg_coff`` from ``seg_start``
                # on; before that, the head of a record that started in an
                # earlier block (at virtual offset ``head_vo``). Records starting
                # at or past ``stop`` belong to the next chunk. The chunk's first
                # block is inflated like any other, then entered at ``skip``.
                data, nxt, skip = b"", u >> 16, u & 0xFFFF
                off = seg_start = seg_coff = head_vo = 0
                stop = _NO_LIMIT
                while off < stop:
                    n = len(data)
                    if n - off >= 36:
                        bs, refid, pos, l_rn, _mq, _bin, n_cig, flag, l_seq = fixed(data, off)
                        if (bs < 32 + l_rn + 4 * n_cig + ((l_seq + 1) >> 1) + l_seq or bs > _MAX_RECORD
                                or l_seq < 0 or not l_rn):
                            raise ValueError("malformed alignment record")
                        if refid != tid or pos >= end:
                            done = True                   # sorted: nothing further overlaps
                            break
                        if (lead >= lead_limit) if pos < beg else (seen >= limit):
                            res.complete = False          # a budget is spent: stop at this record
                            res.scanned_to = pos
                            done = True
                            break
                        if n - off >= 4 + bs:
                            if pos >= beg:
                                seen += 1
                                if flag & skip_flags:
                                    off += 4 + bs
                                    continue
                            else:                         # starts left of the window: reaches it?
                                lead += 1
                                if flag & skip_flags:
                                    off += 4 + bs
                                    continue
                                if n_cig == 1:            # most short reads: one CIGAR word
                                    c, = word(data, off + 36 + l_rn)
                                    if pos + (c >> 4) <= beg or not _REF_OPS >> (c & 0xF) & 1:
                                        off += 4 + bs
                                        continue
                                elif n_cig < _SHORT_CIGAR:
                                    words = _CIGAR_WORDS[n_cig](data, off + 36 + l_rn)
                                    if n_cig == 2 and words[0] == (l_seq << 4 | 4) and words[1] & 0xF == 3:
                                        reach = _ref_end(data, off)   # kSmN: the CIGAR is in the CG tag
                                    else:
                                        reach = pos
                                        for c in words:
                                            if _REF_OPS >> (c & 0xF) & 1:
                                                reach += c >> 4
                                    if reach <= beg:
                                        off += 4 + bs
                                        continue
                                elif _ref_end(data, off) <= beg:
                                    off += 4 + bs
                                    continue
                            vofs.append((seg_coff << 16) | (off - seg_start) if off >= seg_start else head_vo)
                            starts.append(pos)
                            keys.append(crc32(data[off + 36:off + 35 + l_rn], (pos * 0x9E3779B1 ^ flag) & 0xFFFFFFFF))
                            if records is not None:
                                kept_bytes += 4 + bs
                                if len(vofs) <= keep and kept_bytes <= _KEEP_BYTES:
                                    records.append(data[off:off + 4 + bs])
                                else:
                                    records = None        # too many: decode from the file later
                            off += 4 + bs
                            continue
                        need = 4 + bs
                    elif n - off >= 4:
                        # Check the size before inflating more for it: a corrupt
                        # one must not pull in the rest of the file.
                        need = 4 + unpack_from("<i", data, off)[0]
                        if not 36 <= need <= 4 + _MAX_RECORD:
                            raise ValueError("malformed alignment record")
                    else:
                        need = 4
                    # The next record is not complete here: inflate the next
                    # block, or as many as a record that spans several needs
                    # (joined once, so a long record costs linear time).
                    pending = n - off if off < n else 0
                    if not pending and nxt << 16 >= v:
                        break                             # the chunk ends at this block's end
                    if pending:
                        head_vo = (seg_coff << 16) | (off - seg_start) if off >= seg_start else head_vo
                    parts, have = [data[off:]] if pending else [], pending
                    while True:
                        if is_current is not None and blocks.inflated >= polled + _POLL_BLOCKS:
                            polled = blocks.inflated
                            if not is_current():
                                res.cancelled = True
                                return res
                        nd, nn = blocks.get(nxt)
                        if pending and not nd:
                            raise EOFError("the BAM ends inside an alignment record")
                        parts.append(nd)
                        seg_start, seg_coff, nxt = have, nxt, nn
                        have += len(nd)
                        if not pending or have >= need:
                            break
                    data = parts[0] if len(parts) == 1 else b"".join(parts)
                    off, skip = skip, 0
                    stop = (seg_start + vu if seg_coff == vblk
                            else seg_start if seg_coff > vblk else _NO_LIMIT)
                if done:
                    break
        res.examined = seen + lead
        res.leading = lead
        res.records = records
        return res

    def read(self, vofs, is_current=None) -> list[bytes] | None:
        """The records at virtual offsets ``vofs`` (ascending), or None when
        is_current() turned False meanwhile."""
        out = []
        unpack_from = struct.unpack_from
        with open(self.bam_path, "rb", buffering=_FILE_BUFFER) as fh:
            blocks = _Blocks(fh)
            polled = 0
            for vo in vofs:
                data, nxt = blocks.get(vo >> 16)
                off = vo & 0xFFFF
                if blocks.inflated >= polled + _POLL_BLOCKS:
                    polled = blocks.inflated
                    if is_current is not None and not is_current():
                        return None
                if len(data) - off >= 4 and len(data) - off >= 4 + unpack_from("<i", data, off)[0]:
                    out.append(data[off:off + 4 + unpack_from("<i", data, off)[0]])
                    continue
                buf = data[off:]                  # the record continues in the next block(s)
                while len(buf) < 4:
                    more, nxt = blocks.get(nxt)
                    if not more:
                        raise EOFError("the BAM ends inside an alignment record")
                    buf += more
                need = 4 + unpack_from("<i", buf, 0)[0]
                if not 36 <= need <= 4 + _MAX_RECORD:
                    raise ValueError("malformed alignment record")
                parts, have = [buf], len(buf)
                while have < need:                # joined once: linear in the record's size
                    more, nxt = blocks.get(nxt)
                    if not more:
                        raise EOFError("the BAM ends inside an alignment record")
                    parts.append(more)
                    have += len(more)
                out.append(b"".join(parts)[:need])
        return out


def _cg_cigar(rec, p: int, rec_end: int):
    """The CIGAR in the CG:B:I tag of the aux data rec[p:rec_end], or None."""
    while p + 3 <= rec_end:
        tag, t = rec[p:p + 2], rec[p + 2]
        p += 3
        size = _AUX_SIZE.get(t)
        if size is not None:
            p += size
        elif t == 90 or t == 72:                    # Z, H: NUL-terminated
            p = rec.index(b"\0", p, rec_end) + 1
        elif t == 66:                               # B: typed array
            sub, count = rec[p], struct.unpack_from("<i", rec, p + 1)[0]
            p += 5
            if count < 0 or p + count * _AUX_SIZE[sub] > rec_end:
                raise ValueError("malformed aux data")
            if tag == b"CG" and sub == 73:          # I
                return struct.unpack_from("<%dI" % count, rec, p)
            p += count * _AUX_SIZE[sub]
        else:
            raise ValueError("malformed aux data")
    return None


def _cigar_words(rec, off: int) -> tuple:
    """Raw CIGAR words of the record at rec[off:], the real CIGAR from the CG
    tag when the stored one is the kSmN placeholder of a read with more than
    65,535 operations (as htslib and bamnostic do)."""
    bs, l_rn, n_cig, l_seq = struct.unpack_from("<i8xB3xH2xi", rec, off)
    p = off + 36 + l_rn
    words = struct.unpack_from("<%dI" % n_cig, rec, p)
    if n_cig == 2 and words[0] == (l_seq << 4 | 4) and words[1] & 0xF == 3:
        real = _cg_cigar(rec, p + 4 * n_cig + ((l_seq + 1) >> 1) + l_seq, off + 4 + bs)
        if real is not None:
            return real
    return words


def _ref_end(rec, off: int) -> int:
    """Reference end of the record at rec[off:]: pos + the reference length of
    its CIGAR, at least pos + 1 (htslib's bam_endpos)."""
    pos, = struct.unpack_from("<i", rec, off + 8)
    rlen = 0
    for c in _cigar_words(rec, off):
        if _REF_OPS >> (c & 0xF) & 1:
            rlen += c >> 4
    return pos + (rlen or 1)


def decode_record(rec: bytes) -> tuple:
    """(pos, end, flag, mapq, name, cigar, seq) of one record (with its
    block_size prefix). ``cigar`` is a [(length, op)] list, ``end`` the true
    reference end, ``seq`` "" when the record stores no SEQ."""
    _bs, _ref, pos, l_rn, mapq, _bin, n_cig, flag, l_seq = struct.unpack_from("<iiiBBHHHi", rec, 0)
    name = rec[36:35 + l_rn].decode("utf-8", "replace")
    p = 36 + l_rn + 4 * n_cig
    nb = (l_seq + 1) >> 1
    if l_seq:
        packed = rec[p:p + nb]
        seq = bytearray(2 * nb)
        seq[0::2] = packed.translate(_SEQ_HI)
        seq[1::2] = packed.translate(_SEQ_LO)
        seq = seq[:l_seq].decode("ascii")
    else:
        seq = ""
    cigar = [(c >> 4, _CIGAR_CHARS[c & 0xF]) for c in (_cigar_words(rec, 0) if n_cig else ())]
    rlen = sum(n for n, op in cigar if op in "MDN=X")
    return pos, pos + (rlen or 1), flag, mapq, name, cigar, seq
