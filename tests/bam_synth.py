"""
A minimal pure-Python BAM + BAI writer for synthetic test files, and the
per-base depth a BAM should have by the coverage index's counting rules.

A read is a dict: {ref, pos, cigar: [(length, op)], flag?, name?, cg?}. With
``cg`` the CIGAR is stored in the CG:B:I tag behind the kSmN placeholder, as
for reads of more than 65,535 operations. Records are written in the order
given, so an out-of-order list makes an unsorted BAM.
"""

import struct
import zlib

OPS = "MIDNSHP=X"
BLOCK = 65280                      # uncompressed bytes per BGZF block
EOF_BLOCK = bytes.fromhex("1f8b08040000000000ff0600424302001b0003000000000000000000")
SKIP_FLAGS = 0x4 | 0x200 | 0x400


def reg2bin(beg, end):
    end -= 1
    for shift, first in ((14, 4681), (17, 585), (20, 73), (23, 9), (26, 1)):
        if beg >> shift == end >> shift:
            return first + (beg >> shift)
    return 0


def _ref_span(cigar):
    return sum(n for n, op in cigar if op in "MDN=X")


def _query_len(cigar):
    return sum(n for n, op in cigar if op in "MIS=X")


def _record(r, refid):
    cigar = r["cigar"]
    l_seq = _query_len(cigar)
    name = r.get("name", "r").encode() + b"\0"
    end = r["pos"] + max(_ref_span(cigar), 1)
    if r.get("cg"):
        stored = [(l_seq << 4) | 4, (_ref_span(cigar) << 4) | 3]   # kSmN placeholder
    else:
        stored = [(n << 4) | OPS.index(op) for n, op in cigar]
    aux = b""
    if r.get("cg"):
        real = [(n << 4) | OPS.index(op) for n, op in cigar]
        aux = b"CGBI" + struct.pack("<I", len(real)) + struct.pack("<%dI" % len(real), *real)
    body = struct.pack("<iiBBHHHiiii", refid, r["pos"], len(name), 60, reg2bin(r["pos"], end),
                       len(stored), r.get("flag", 0), l_seq, -1, -1, 0)
    body += name + struct.pack("<%dI" % len(stored), *stored)
    body += bytes([0x11] * ((l_seq + 1) // 2)) + bytes([30] * l_seq) + aux
    return struct.pack("<i", len(body)) + body, end


def write_bam(path, refs, reads, sorted_header=True, truncate_at=None):
    """Write ``reads`` on ``refs`` ([(name, length)]) to ``path``, with a
    .bai beside it. ``truncate_at``: cut the BAM's uncompressed stream after
    that many bytes of alignment records (a file that ends inside one)."""
    names = [n for n, _ in refs]
    text = (b"@HD\tVN:1.6\tSO:coordinate\n" if sorted_header else b"@HD\tVN:1.6\tSO:unsorted\n")
    text += b"".join(b"@SQ\tSN:%s\tLN:%d\n" % (n.encode(), L) for n, L in refs)
    stream = bytearray(b"BAM\1" + struct.pack("<i", len(text)) + text + struct.pack("<i", len(refs)))
    for n, L in refs:
        nb = n.encode() + b"\0"
        stream += struct.pack("<i", len(nb)) + nb + struct.pack("<i", L)
    header_len = len(stream)
    meta = []                                   # (refid, pos, end, ustart, uend)
    for r in reads:
        refid = names.index(r["ref"])
        rec, end = _record(r, refid)
        meta.append((refid, r["pos"], end, len(stream), len(stream) + len(rec)))
        stream += rec
    if truncate_at is not None:
        del stream[header_len + truncate_at:]
    coffs, out = [], bytearray()
    for i in range(0, len(stream), BLOCK):
        piece = bytes(stream[i:i + BLOCK])
        co = zlib.compressobj(6, zlib.DEFLATED, -15)
        cdata = co.compress(piece) + co.flush()
        bsize = 12 + 6 + len(cdata) + 8
        out += struct.pack("<BBBBIBBHBBHH", 31, 139, 8, 4, 0, 0, 255, 6, 66, 67, 2, bsize - 1)
        out += cdata + struct.pack("<II", zlib.crc32(piece) & 0xFFFFFFFF, len(piece))
        coffs.append(len(out) - bsize)
    end_coff = len(out)
    out += EOF_BLOCK
    with open(path, "wb") as fh:
        fh.write(out)

    def vo(u):
        k = u // BLOCK
        return (end_coff << 16) if k >= len(coffs) else (coffs[k] << 16) | (u % BLOCK)

    bai = bytearray(b"BAI\1" + struct.pack("<i", len(refs)))
    for refid in range(len(refs)):
        bins, lin, first = {}, {}, None
        for rid, pos, end, us, ue in meta:
            if rid != refid:
                continue
            vb, ve = vo(us), vo(ue)
            first = vb if first is None else first
            chunks = bins.setdefault(reg2bin(pos, end), [])
            if chunks and chunks[-1][1] == vb:
                chunks[-1][1] = ve
            else:
                chunks.append([vb, ve])
            for w in range(pos >> 14, ((end - 1) >> 14) + 1):
                lin[w] = min(lin.get(w, vb), vb)
        bai += struct.pack("<i", len(bins))
        for b, chunks in bins.items():
            bai += struct.pack("<Ii", b, len(chunks))
            for vb, ve in chunks:
                bai += struct.pack("<QQ", vb, ve)
        n_intv = max(lin) + 1 if lin else 0
        bai += struct.pack("<i", n_intv)
        prev = first or 0
        for w in range(n_intv):
            prev = lin.get(w, prev)
            bai += struct.pack("<Q", prev)
    bai += struct.pack("<Q", 0)
    with open(path + ".bai", "wb") as fh:
        fh.write(bai)


def expected_depth(refs, reads):
    """Per-base depth by the coverage index's rules: aligned bases (M = X)
    of reads without the unmapped / QC-fail / duplicate flags."""
    lens = dict(refs)
    depth = {n: [0] * L for n, L in refs}
    for r in reads:
        if r.get("flag", 0) & SKIP_FLAGS:
            continue
        p, d, L = r["pos"], depth[r["ref"]], lens[r["ref"]]
        for n, op in r["cigar"]:
            if op in "M=X":
                for x in range(max(p, 0), min(p + n, L)):
                    d[x] += 1
                p += n
            elif op in "DN":
                p += n
    return depth


def expected_bins(depth, start, end, bins):
    """The bins a coverage query over [start, end) should return."""
    L = len(depth)
    n = min(bins, end - start)
    size = (end - start) / n
    edges = [start + int(i * size) for i in range(n)] + [end]
    out = []
    for i in range(n):
        lo, hi = edges[i], edges[i + 1]
        b = {"start": lo, "end": hi}
        a, c = max(lo, 0), min(hi, L)
        if c <= a:
            b.update(value=0.0, max=0.0, min=0.0, cov=0)
        else:
            seg = depth[a:c]
            b.update(value=sum(seg) / (c - a), max=float(max(seg)), min=float(min(seg)), cov=c - a)
        out.append(b)
    return out
