"""
BiNgo Genome Viewer icon generator.

Produces a bingo-ball icon as PNG bytes using only the Python standard
library (struct + zlib).  No Pillow / PIL dependency required.

Public API
----------
generate_png(size=48) -> bytes   -- RGBA PNG of the ball
generate_ico(sizes=[48,32,16]) -> bytes  -- ICO wrapping PNG data for each size
"""

import math
import struct
import zlib


# ── colour palette ──────────────────────────────────────────────────────
_BLUE      = (0x19, 0x76, 0xD2)  # main ball colour
_HIGHLIGHT = (0x42, 0xA5, 0xF5)  # lighter highlight toward top-left
_RING      = (0x15, 0x65, 0xC0)  # ring around the inner white circle
_WHITE     = (0xFF, 0xFF, 0xFF)


def _lerp(a, b, t):
    """Linear interpolation between scalars *a* and *b*."""
    return a + (b - a) * t


def _lerp_color(c1, c2, t):
    """Linear interpolation between two (R, G, B) tuples."""
    return (
        int(_lerp(c1[0], c2[0], t)),
        int(_lerp(c1[1], c2[1], t)),
        int(_lerp(c1[2], c2[2], t)),
    )


def _clamp(v, lo=0, hi=255):
    return max(lo, min(hi, int(v)))


# ── PNG writer (minimal, RGBA) ──────────────────────────────────────────
def _make_png(width, height, rows):
    """
    Build a PNG file from *rows*, a list of *height* byte-strings each
    containing *width* * 4 bytes (RGBA).
    """

    def _chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + c + crc

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = _chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0),
    )
    # Build raw image data with filter byte 0 (None) per row
    raw = b""
    for row in rows:
        raw += b"\x00" + row
    idat = _chunk(b"IDAT", zlib.compress(raw, 9))
    iend = _chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


# ── icon renderer ───────────────────────────────────────────────────────
def generate_png(size=48):
    """Return PNG bytes for a *size* x *size* bingo-ball icon."""
    cx = cy = size / 2.0
    outer_r = size / 2.0 - 1.0          # outer circle radius (1 px margin)
    inner_r = outer_r * 0.56            # white inner circle
    ring_r  = inner_r + max(1.0, outer_r * 0.06)  # ring just outside inner

    # Highlight centre (shifted toward top-left)
    hx = cx - outer_r * 0.30
    hy = cy - outer_r * 0.30

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            dist = math.sqrt(dx * dx + dy * dy)

            # --- outside the ball → transparent ---
            if dist > outer_r + 0.5:
                row += b"\x00\x00\x00\x00"
                continue

            # Anti-alias the outer edge
            if dist > outer_r - 0.5:
                aa = _clamp((outer_r + 0.5 - dist) * 255)
            else:
                aa = 255

            # --- distance from highlight centre (for gradient) ---
            hdx = x + 0.5 - hx
            hdy = y + 0.5 - hy
            hdist = math.sqrt(hdx * hdx + hdy * hdy)
            ht = min(1.0, hdist / (outer_r * 1.4))  # 0 at highlight, 1 far

            # --- inner white circle ---
            if dist < inner_r - 0.5:
                # pure white interior
                row += bytes([0xFF, 0xFF, 0xFF, aa])
                continue

            # --- anti-aliased ring border ---
            if dist < inner_r + 0.5:
                # transition from white to ring colour
                blend = _clamp((dist - (inner_r - 0.5)) * 255) / 255.0
                r, g, b = _lerp_color(_WHITE, _RING, blend)
                row += bytes([r, g, b, aa])
                continue

            if dist < ring_r + 0.5:
                # ring area → solid ring colour fading into ball
                if dist > ring_r - 0.5:
                    blend = (ring_r + 0.5 - dist)
                    base = _lerp_color(_BLUE, _HIGHLIGHT, 1.0 - ht)
                    r, g, b = _lerp_color(base, _RING, blend)
                else:
                    r, g, b = _RING
                row += bytes([r, g, b, aa])
                continue

            # --- blue ball body with highlight gradient ---
            base = _lerp_color(_HIGHLIGHT, _BLUE, ht)
            # Slight specular highlight near top-left
            spec = max(0.0, 1.0 - hdist / (outer_r * 0.55))
            spec = spec ** 3
            r = _clamp(base[0] + spec * 80)
            g = _clamp(base[1] + spec * 80)
            b = _clamp(base[2] + spec * 80)
            row += bytes([r, g, b, aa])

        rows.append(bytes(row))

    return _make_png(size, size, rows)


# ── ICO writer (PNG-in-ICO) ─────────────────────────────────────────────
def generate_ico(sizes=None):
    """
    Return ICO bytes containing PNG data for each requested *size*.

    Uses the PNG-in-ICO format supported by Windows Vista+ and all
    modern icon renderers.
    """
    if sizes is None:
        sizes = [48, 32, 16]

    png_blobs = [generate_png(s) for s in sizes]
    num = len(sizes)

    # ICO header: 6 bytes
    header = struct.pack("<HHH", 0, 1, num)

    # Each directory entry: 16 bytes
    # Data starts after header + all directory entries
    data_offset = 6 + 16 * num
    entries = b""
    for i, s in enumerate(sizes):
        w = 0 if s >= 256 else s  # 0 means 256 in ICO spec
        h = w
        blob = png_blobs[i]
        entries += struct.pack(
            "<BBBBHHII",
            w,            # width
            h,            # height
            0,            # colour count (0 = no palette)
            0,            # reserved
            1,            # colour planes
            32,           # bits per pixel
            len(blob),    # size of PNG data
            data_offset,  # offset to PNG data
        )
        data_offset += len(blob)

    return header + entries + b"".join(png_blobs)
