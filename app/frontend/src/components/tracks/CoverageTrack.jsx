/**
 * CoverageTrack.jsx — Canvas renderer for signal/coverage data (BigWig, WIG, BedGraph).
 *
 * Draws vertical bars with optional forward/reverse strand split.
 * Supports auto or fixed bar width, log scale, and custom Y-axis range.
 *
 * Each bin is summarised by the track's windowing function — Max (default,
 * peak-preserving) or Mean — and the auto Y axis is computed from exactly that
 * statistic, so the scale always describes what is drawn: zooming out can no
 * longer shrink a peak below the axis it was measured against. The axis comes
 * from coverageAxis, the rule the SVG export and Track Settings share.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTracks } from '../../store/TrackContext'
import { useTrackData, computeAutoScale, needsSplitLayout, useLiveDataVersion } from '../../hooks/useTrackData'
import { binHigh, binLow, windowingOf, formatValue, coverageStyle, coverageAxis, clipWarnings } from '../../utils/coverageStats'

export const LOG_LABEL = ' log₂(x+1)'

function logScale(val, max) {
  // Maps val ∈ [0, max] → [0, 1] on a log₂(x+1) scale
  if (val <= 0 || max <= 0) return 0
  return Math.log2(val + 1) / Math.log2(max + 1)
}

/** Fraction of the axis a value fills, clamped to [0, 1] so values above a
 *  fixed maximum stop at the max line instead of running into the label margin. */
export function axisRatio(v, max, useLog) {
  const r = useLog ? logScale(v, max) : v / max
  return r > 1 ? 1 : (r > 0 ? r : 0)
}

/** Return the barColor override for a position, or null if none applies.
 * Pre-filters overlays to only those on the current chromosome for speed. */
function getRegionBarColor(filteredOverlays, pos) {
  for (let i = 0; i < filteredOverlays.length; i++) {
    const o = filteredOverlays[i]
    if (pos >= o.start && pos < o.end) return o.barColor
  }
  return null
}

export default function CoverageTrack({
  track, width, height, onWarning, overlayRole, barAlpha = 1,
  // When set (by OverlayTrackPanel), every member of the group uses these shared
  // scale settings (the host's) so all layers — and the single label drawn by
  // the base — agree, regardless of each member's own scaleMax/logScale.
  overlayScaleMax, overlayScaleMin, overlayLogScale,
}) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()
  const { tracks } = useTracks()
  const { data, loading, error } = useTrackData(track, region, width)
  // 'overlay' = a non-base layer in an overlay group: it must stay transparent
  // (no opaque background, no duplicate scale labels) so the layers below show
  // through. 'base' = the bottom layer of a group; it owns the background and
  // the shared scale labels. undefined = a normal standalone track.
  const isOverlayLayer = overlayRole === 'overlay'
  const inOverlay = overlayRole === 'overlay' || overlayRole === 'base'
  // Tracks that derive their axis from siblings (overlay groups, linked scales)
  // must re-draw when any sibling's data loads — see useLiveDataVersion.
  const liveVersion = useLiveDataVersion(!!(track.overlayGroup || track.linkScale))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (!isOverlayLayer) {
      ctx.fillStyle = theme.canvasBg
      ctx.fillRect(0, 0, width, height)
    }

    if (loading && !data?.bins?.length) {
      if (!isOverlayLayer) {
        ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
        ctx.fillText('Loading…', 8, height / 2 + 4)
      }
      if (onWarning) onWarning(null)
      return
    }
    // If we have stale data, prefer drawing it over a blank "Network error"
    // splash — the user keeps their context and the failure surfaces as a
    // non-blocking warning badge instead.
    if (error && !data?.bins?.length) {
      if (!isOverlayLayer) {
        ctx.fillStyle = '#ef9a9a'; ctx.font = '11px Arial, Helvetica, sans-serif'
        ctx.fillText(typeof error === 'string' ? error : JSON.stringify(error), 8, height / 2 + 4)
      }
      if (onWarning) onWarning(null)
      return
    }
    if (!data?.bins?.length) {
      if (onWarning) onWarning(null)
      return
    }

    const bins = data.bins
    const windowing = windowingOf(track)
    const hi = (b) => binHigh(b, windowing)     // >= 0
    const lo = (b) => binLow(b, windowing)      // <= 0
    // Split layout (forward up / reverse down): decided chromosome-wide (and
    // group-wide for overlays and linked tracks) so it doesn't flip as you pan.
    const hasNegative = needsSplitLayout(track, region, tracks)
    const regionStart = region.start
    const regionLen = region.end - region.start
    const color = track.color || '#78909c'
    // In an overlay group every layer (and the base's single label) uses the
    // shared fixed-scale / log settings passed down from the host.
    const userScaleMax = inOverlay
      ? (overlayScaleMax != null ? overlayScaleMax : null)
      : (track.scaleMax != null ? track.scaleMax : null)
    const userScaleMin = inOverlay
      ? (overlayScaleMin != null ? overlayScaleMin : null)
      : (track.scaleMin != null ? track.scaleMin : null)
    const useLog = inOverlay ? overlayLogScale === true : track.logScale === true
    const barAuto = track.barAutoWidth !== false
    const barFixedPx = track.barWidth || 2
    const outlineColor = track.outlineColor || null
    // Smooth fill draws a single-colour area under the (smoothed) peak-outline
    // curve in place of the discrete bars, so the bars are off while it's on.
    const { bars: drawBars, fill: fillArea, outline: showOutline, curve: wantCurve, smooth: outlineSmooth } = coverageStyle(track)
    // The axis (coverageAxis): the auto scale of the drawn statistic over the
    // visible region (default) or the fetched range, the track's link/overlay
    // group sharing one axis — or, with the bars hidden, the smoothed curve —
    // unless a fixed scale is set.
    const axis = coverageAxis(track, bins, region, {
      auto: computeAutoScale(track, region, tracks),
      split: hasNegative,
      grouped: inOverlay || !!track.linkScale,
      scaleMax: userScaleMax,
      scaleMin: userScaleMin,
    })
    const axisNote = (useLog ? LOG_LABEL : '') + (axis.smoothed ? ' smoothed' : '')
    // Pre-filter overlays for current chromosome (avoids per-bin filtering)
    const regionOverlays = (track.regionOverlays || []).filter(o => o.barColor && o.chrom === region.chrom)
    const fwdColor = color
    const revColor = adjustColor(color, -40)

    // Pixels per single nucleotide — when zoomed in enough that each nt
    // is >1px, cap auto bars to pxPerNt so single-position signals don't
    // visually span the entire bin. When zoomed out (pxPerNt < 1), use
    // the full bin width so there are no gaps.
    const pxPerNt = width / regionLen

    function autoBarWidth(binW) {
      if (!barAuto) return Math.min(barFixedPx, binW)
      if (pxPerNt >= 1) return Math.max(1, Math.min(pxPerNt, binW))
      return Math.max(1, binW)
    }

    // Curve (peak outline / smooth fill): the drawn statistic, smoothed.
    const xs = bins.map(b => ((b.start + b.end) / 2 - regionStart) / regionLen * width)
    const { curveHi, curveLo } = axis

    if (hasNegative) {
      const margin = 12
      const midY = Math.round(height / 2)
      const topH = midY - margin / 2
      const botH = height - midY - margin / 2
      const posMax = axis.max
      const negMax = axis.min

      // Center line is structural — only the base/standalone layer draws it.
      if (!isOverlayLayer) drawCenterLine(ctx, width, height, theme)

      ctx.globalAlpha = barAlpha
      if (drawBars) {
        for (const bin of bins) {
          if (bin.pending) continue
          const binMid = (bin.start + bin.end) / 2
          const override = getRegionBarColor(regionOverlays, binMid)
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = autoBarWidth(binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const fwd = hi(bin)
          const rev = lo(bin)
          if (fwd > 0) {
            const ratio = axisRatio(fwd, posMax, useLog)
            ctx.fillStyle = override || fwdColor; ctx.fillRect(x, midY - ratio * topH, w, ratio * topH)
          }
          if (rev < 0) {
            const ratio = axisRatio(-rev, negMax, useLog)
            ctx.fillStyle = override || revColor; ctx.fillRect(x, midY, w, ratio * botH)
          }
        }
      }

      // Peak-outline curve and/or smooth fill share the same smoothed values so
      // the filled area and the stroke on top of it line up exactly.
      if (wantCurve && bins.length > 0) {
        const fwdStroke = outlineColor || theme.textPrimary || '#fff'
        const revStroke = outlineColor || theme.textPrimary || '#fff'
        const fwdYs = curveHi.map(v => midY - axisRatio(v, posMax, useLog) * topH)
        const revYs = curveLo.map(v => midY + axisRatio(v, negMax, useLog) * botH)
        if (fillArea) {
          drawFilledArea(ctx, xs, fwdYs, midY, fwdColor, outlineSmooth > 0)
          drawFilledArea(ctx, xs, revYs, midY, revColor, outlineSmooth > 0)
        }
        if (showOutline) {
          drawSmoothLine(ctx, xs, fwdYs, fwdStroke, outlineSmooth > 0)
          drawSmoothLine(ctx, xs, revYs, revStroke, outlineSmooth > 0)
        }
      }
      ctx.globalAlpha = 1
      if (!isOverlayLayer) drawPending(ctx, bins, regionStart, regionLen, width, height, theme)
    } else {
      const effectiveMax = axis.max
      ctx.globalAlpha = barAlpha
      if (drawBars) {
        for (const bin of bins) {
          if (bin.pending) continue
          const h = hi(bin)
          if (h <= 0) continue
          const binMid = (bin.start + bin.end) / 2
          const override = getRegionBarColor(regionOverlays, binMid)
          ctx.fillStyle = override || fwdColor
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = autoBarWidth(binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const barH = axisRatio(h, effectiveMax, useLog) * (height - 14)
          ctx.fillRect(x, height - barH - 2, w, barH)
        }
      }
      if (wantCurve && bins.length > 0) {
        const ys = curveHi.map(v => height - axisRatio(v, effectiveMax, useLog) * (height - 14) - 2)
        if (fillArea) drawFilledArea(ctx, xs, ys, height - 2, color, outlineSmooth > 0)
        if (showOutline) drawSmoothLine(ctx, xs, ys, outlineColor || theme.textPrimary || '#fff', outlineSmooth > 0)
      }
      ctx.globalAlpha = 1
      if (!isOverlayLayer) drawPending(ctx, bins, regionStart, regionLen, width, height, theme)
    }
    // Scale labels are structural too — one set per row, from the base layer.
    if (!isOverlayLayer) drawAxisLabels(ctx, axis, hasNegative, axisNote, height, theme)

    // Warnings: refresh failures, coverage still being computed, and values
    // clipped by a fixed scale (judged on what is drawn — the bars, or the
    // curve when they are hidden — over the visible region, not the overscan).
    if (onWarning) {
      const warnings = []
      if (error) {
        const msg = typeof error === 'string' ? error : JSON.stringify(error)
        warnings.push(`Update failed: ${msg} — showing last loaded data`)
      }
      if (data.complete === false) {
        warnings.push(`Computing exact coverage… ${Math.round(100 * (data.coverage_progress || 0))}% (shaded part pending)`)
      }
      if (data.truncated) {
        warnings.push('Coverage incomplete at this zoom (read limit reached) — shaded part not computed; zoom in for exact values')
      }
      warnings.push(...clipWarnings(track, bins, axis, region, { scaleMax: userScaleMax, scaleMin: userScaleMin, split: hasNegative }))
      onWarning(warnings.length > 0 ? warnings.join('\n') : null)
    }
  }, [data, loading, error, width, height, region, track.color, track.scaleMax, track.scaleMin, track.logScale, track.barAutoWidth, track.barWidth, track.showOutline, track.outlineColor, track.outlineSmooth, track.showBars, track.fillArea, track.windowing, track.regionOverlays, track.autoScaleVisible, track.linkScale, track.overlayGroup, overlayRole, barAlpha, overlayScaleMax, overlayScaleMin, overlayLogScale, liveVersion, tracks, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
}

/** Opacity of the shade over data that is not computed (or not scanned) yet. */
export const PENDING_ALPHA = 0.12

/** Pixel spans [x0, x1] of the runs of consecutive pending bins (not computed
 *  yet: a BAM's background coverage index still building, or past the live
 *  fallback's read cap). The SVG export shades the same spans. */
export function pendingRuns(bins, regionStart, regionLen, width) {
  const runs = []
  let runStart = null
  for (let i = 0; i <= bins.length; i++) {
    const p = i < bins.length && bins[i].pending
    if (p && runStart == null) runStart = bins[i].start
    if (!p && runStart != null) {
      runs.push([((runStart - regionStart) / regionLen) * width, ((bins[i - 1].end - regionStart) / regionLen) * width])
      runStart = null
    }
  }
  return runs
}

/** Shade the full height of [x0, x1): data that is missing there is not
 *  known yet, and must never be mistaken for zero. */
export function shadePending(ctx, x0, x1, height, theme) {
  ctx.save()
  ctx.globalAlpha = PENDING_ALPHA
  ctx.fillStyle = theme.textTertiary || '#888'
  ctx.fillRect(x0, 0, x1 - x0, height)
  ctx.restore()
}

/** Shade the runs of bins that are not computed yet (pendingRuns). */
export function drawPending(ctx, bins, regionStart, regionLen, width, height, theme) {
  for (const [x0, x1] of pendingRuns(bins, regionStart, regionLen, width)) shadePending(ctx, x0, x1, height, theme)
}

/** Centre line of the split (+/−) layout. Like the scale labels it belongs to
 *  the row, so only the base/standalone layer draws it — and the PNG export,
 *  for an overlay row whose base layer is left out. */
export function drawCenterLine(ctx, width, height, theme) {
  const midY = Math.round(height / 2)
  ctx.strokeStyle = theme.centerLine; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(width, midY); ctx.stroke()
}

/** Scale labels of an axis from coverageAxis: +max, −min and 0 in the split
 *  layout, max and 0 otherwise, each value followed by `note`. */
export function drawAxisLabels(ctx, axis, split, note, height, theme) {
  if (split) {
    drawScaleLabel(ctx, `+${formatValue(axis.max)}${note}`, 2, 2, theme)
    drawScaleLabel(ctx, `−${formatValue(axis.min)}${note}`, 2, height - 12, theme)
    drawScaleLabel(ctx, '0', 2, Math.round(height / 2) - 6, theme, true)
  } else {
    drawScaleLabel(ctx, `${formatValue(axis.max)}${note}`, 2, 2, theme)
    drawScaleLabel(ctx, '0', 2, height - 12, theme, true)
  }
}

/** Fill the area between a (smooth or step) curve and a baseline with a flat
 *  colour. Traces the same top edge as drawSmoothLine so a stroke drawn after
 *  sits exactly on the fill's upper boundary. */
function drawFilledArea(ctx, xs, ys, baseY, color, smooth) {
  if (xs.length < 2) return
  ctx.beginPath()
  ctx.moveTo(xs[0], baseY)
  ctx.lineTo(xs[0], ys[0])
  if (smooth) {
    for (let i = 0; i < xs.length - 1; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2
      const my = (ys[i] + ys[i + 1]) / 2
      ctx.quadraticCurveTo(xs[i], ys[i], mx, my)
    }
    ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1])
  } else {
    for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i])
  }
  ctx.lineTo(xs[xs.length - 1], baseY)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

/** Draw a smooth or step line through an array of (x, y) points. */
function drawSmoothLine(ctx, xs, ys, color, smooth) {
  if (xs.length < 2) return
  ctx.beginPath()
  ctx.moveTo(xs[0], ys[0])
  if (smooth) {
    // Catmull-Rom style: quadratic curves through midpoints
    for (let i = 0; i < xs.length - 1; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2
      const my = (ys[i] + ys[i + 1]) / 2
      ctx.quadraticCurveTo(xs[i], ys[i], mx, my)
    }
    ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1])
  } else {
    for (let i = 0; i < xs.length; i++) {
      ctx.lineTo(xs[i], ys[i])
    }
  }
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
}

/** Draw a scale label with a semi-transparent background so it's always readable. */
function drawScaleLabel(ctx, text, x, y, theme, muted = false) {
  ctx.font = '10px Arial, Helvetica, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const metrics = ctx.measureText(text)
  const pad = 2
  const tw = metrics.width + pad * 2
  const th = 12
  // Background pill
  ctx.fillStyle = theme.canvasBg || '#1e1e1e'
  ctx.globalAlpha = 0.75
  ctx.fillRect(x, y, tw, th)
  ctx.globalAlpha = 1.0
  // Text
  ctx.fillStyle = muted ? (theme.textTertiary || '#666') : (theme.textSecondary || '#aaa')
  ctx.fillText(text, x + pad, y + 1)
  ctx.textBaseline = 'alphabetic'  // reset
}

function adjustColor(hex, delta) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  const clamp = v => Math.max(0, Math.min(255, v + delta))
  return `rgb(${clamp(parseInt(m[1], 16))},${clamp(parseInt(m[2], 16))},${clamp(parseInt(m[3], 16))})`
}
