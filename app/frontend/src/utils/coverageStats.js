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
 *
 * coverageAxis is the one rule for the axis a track then draws; the screen,
 * the SVG export and Track Settings (unticking Auto) all use it.
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

/** Smooth an array of values using a moving average window. */
export function smoothValues(values, radius) {
  if (radius <= 0 || values.length === 0) return values
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0
    const lo = Math.max(0, i - radius)
    const hi = Math.min(values.length - 1, i + radius)
    for (let j = lo; j <= hi; j++) { sum += values[j]; count++ }
    out[i] = sum / count
  }
  return out
}

/** How a coverage track (or a read track's coverage view) is drawn: bars
 *  and/or a peak-outline curve (`smooth` = its moving-average radius in bins).
 *  Smooth fill draws a single-colour area under the curve in place of the bars. */
export function coverageStyle(track) {
  const fill = track.fillArea === true
  const outline = track.showOutline === true
  return {
    bars: track.showBars !== false && !fill,
    fill,
    outline,
    curve: fill || outline,
    smooth: track.outlineSmooth || 0,
  }
}

/** The Y axis a coverage track, or a read track's coverage view, draws.
 *
 *  `auto` is computeAutoScale's { max, min }: the drawn statistic over the
 *  track's overlay or link group. With the bars hidden (Smooth fill, or a
 *  smoothed outline with Fill bars off) the smoothed curve IS the track, and it
 *  can never reach a raw maximum (smoothing spreads a peak over neighbouring
 *  bins), so a standalone track fits its auto axis to the curve instead; an
 *  overlay member or linked track (`grouped`) keeps the group's shared axis.
 *  A fixed scale (`scaleMax` / `scaleMin`; null = Auto) replaces the auto value.
 *
 *  Returns { max, min, smoothed, curveHi, curveLo }: `max` is the top of the
 *  axis and `min` the depth of the lower half in the split layout (both > 0, in
 *  data units); `smoothed` is true when the auto axis follows the smoothed curve
 *  (its label says so); curveHi / curveLo are the curve per bin (the positive
 *  side, and for the split layout the negative side as magnitudes), or null
 *  when no curve is drawn. */
export function coverageAxis(track, bins, region, { auto, split = false, grouped = false, scaleMax = null, scaleMin = null }) {
  const style = coverageStyle(track)
  const windowing = windowingOf(track)
  const curveHi = style.curve ? smoothValues(bins.map(b => (b.pending ? 0 : binHigh(b, windowing))), style.smooth) : null
  const curveLo = style.curve && split ? smoothValues(bins.map(b => (b.pending ? 0 : -binLow(b, windowing))), style.smooth) : null
  let hi = auto.max
  let lo = -auto.min
  const fitCurve = !style.bars && style.curve && style.smooth > 0 && !grouped
  if (fitCurve) {
    const visibleOnly = track.autoScaleVisible !== false
    hi = 0
    lo = 0
    for (let i = 0; i < bins.length; i++) {
      if (visibleOnly && (bins[i].end <= region.start || bins[i].start >= region.end)) continue
      if (curveHi[i] > hi) hi = curveHi[i]
      if (curveLo && curveLo[i] > lo) lo = curveLo[i]
    }
  }
  return {
    max: scaleMax != null ? scaleMax : (hi || 1),
    min: scaleMin != null ? scaleMin : (lo || 1),
    smoothed: fitCurve && scaleMax == null,
    curveHi,
    curveLo,
  }
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
