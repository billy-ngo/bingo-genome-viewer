/**
 * coverageStats.js — How a coverage bin is summarised for drawing and scaling.
 *
 * Every coverage bin from the backend carries both its base-pair-weighted mean
 * (`value`, plus `forward`/`reverse` for strand data) and the extremes of the
 * underlying signal (`max` = largest value on the positive side, `min` =
 * smallest on the negative side). The track's windowing function picks which
 * one is drawn — and the Y axis is always computed from the same statistic, so
 * the scale describes exactly what is on screen:
 *   'max'  (default) — peak-preserving: a narrow peak keeps its true height at
 *                       every zoom, so zooming out never shrinks the axis.
 *   'mean'           — average signal per bin (peaks flatten when zoomed out).
 */

export const DEFAULT_WINDOWING = 'max'

export function windowingOf(track) {
  return track && track.windowing === 'mean' ? 'mean' : DEFAULT_WINDOWING
}

/** Height of a bin's positive (upper) bar. */
export function binHigh(b, windowing) {
  if (windowing !== 'mean' && b.max != null) return Math.max(0, b.max)
  const v = b.forward != null ? b.forward : b.value
  return v > 0 ? v : 0
}

/** Depth of a bin's negative (lower) bar — always <= 0. */
export function binLow(b, windowing) {
  if (windowing !== 'mean' && b.min != null) return Math.min(0, b.min)
  const v = b.reverse != null ? b.reverse : b.value
  return v < 0 ? v : 0
}

/** { max, min } of the drawn statistic over `bins`, optionally restricted to
 *  bins overlapping [lo, hi). Pending bins (not computed yet) are ignored. */
export function binExtremes(bins, windowing, lo = -Infinity, hi = Infinity) {
  let max = 0, min = 0
  if (!bins) return { max, min }
  for (const b of bins) {
    if (b.pending || b.end <= lo || b.start >= hi) continue
    const h = binHigh(b, windowing)
    const l = binLow(b, windowing)
    if (h > max) max = h
    if (l < min) min = l
  }
  return { max, min }
}

/** True when the data has a negative side that needs the split layout. */
export function hasNegativeSide(bins, windowing) {
  if (!bins) return false
  for (const b of bins) if (!b.pending && binLow(b, windowing) < 0) return true
  return false
}

/** Compact, precision-preserving number for axis labels and tooltips.
 *  Unlike toFixed(1) it never collapses small normalised values to "0.0"/"0.1"
 *  and keeps large integers intact. */
export function formatValue(v) {
  if (v == null || !Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1000) return Math.round(v).toLocaleString('en-US')
  if (a >= 1) return String(Number(v.toPrecision(4)))
  if (a >= 1e-4) return String(Number(v.toPrecision(3)))
  return v.toExponential(2)
}

/** Human-readable base-pair length: 873 bp, 2.5 kb, 1.2 Mb. */
export function formatBp(n) {
  if (n == null || !Number.isFinite(n)) return '–'
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))} Mb`
  if (n >= 1e3) return `${Number((n / 1e3).toPrecision(3))} kb`
  if (n >= 10) return `${Math.round(n)} bp`
  return `${Number(n.toPrecision(2))} bp`
}
