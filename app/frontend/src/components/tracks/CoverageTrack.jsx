/**
 * CoverageTrack.jsx — Canvas renderer for signal/coverage data (BigWig, WIG, BedGraph).
 *
 * Draws vertical bars with optional forward/reverse strand split.
 * Supports auto or fixed bar width, log scale, and custom Y-axis range.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTracks } from '../../store/TrackContext'
import { useTrackData, computeAutoScale, getLiveTrackData, useLiveDataVersion } from '../../hooks/useTrackData'

const log2 = Math.log2

/** Smooth an array of values using a moving average window. */
function smoothValues(values, radius) {
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

function logScale(val, max) {
  // Maps val ∈ [0, max] → [0, 1] on a log₂ scale
  if (val <= 0 || max <= 0) return 0
  return Math.log2(val + 1) / Math.log2(max + 1)
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
        ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      }
      if (onWarning) onWarning(null)
      return
    }
    // If we have stale data, prefer drawing it over a blank "Network error"
    // splash \u2014 the user keeps their context and the failure surfaces as a
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

    // hasNegative (split forward/reverse rendering) is decided from the
    // fetched-range data so it stays stable across pans; only the scale
    // magnitude is made dynamic below. For an overlay member it must be a
    // GROUP-WIDE decision (any member with negatives ⇒ all layers use the
    // split layout) so the same value maps to the same pixel height on every
    // layer; otherwise a positive-only layer and a negative layer would use
    // different coordinate systems and stop being comparable.
    const hasNegative = track.overlayGroup
      ? tracks.some(t => t.overlayGroup === track.overlayGroup && ((getLiveTrackData(t.id)?.min_value || 0) < 0))
      : (data.min_value || 0) < 0
    // Auto-scale source: visible region and/or a linked group when those
    // toggles are on; otherwise the fetched-range max/min (zoom-only autoscale).
    let maxVal = data.max_value || 0
    let minVal = data.min_value || 0
    // Overlay members always resolve to the shared group axis (so the layered
    // profiles are comparable), even when neither autoScale toggle is set.
    if (track.autoScaleVisible || track.linkScale || track.overlayGroup) {
      const a = computeAutoScale(track, region, tracks)
      maxVal = a.max
      minVal = a.min
    }
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
    const showOutline = track.showOutline === true
    const outlineColor = track.outlineColor || null
    const outlineSmooth = track.outlineSmooth || 0
    const showBars = track.showBars !== false
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

    if (hasNegative) {
      const margin = 12
      const midY = Math.round(height / 2)
      const topH = midY - margin / 2
      const botH = height - midY - margin / 2
      const posMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
      const negMax = userScaleMin != null ? userScaleMin : (Math.abs(minVal) || 1)

      // Center line is structural — only the base/standalone layer draws it.
      if (!isOverlayLayer) {
        ctx.strokeStyle = theme.centerLine; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(width, midY); ctx.stroke()
      }

      ctx.globalAlpha = barAlpha
      if (showBars) {
        for (const bin of data.bins) {
          const binMid = (bin.start + bin.end) / 2
          const override = getRegionBarColor(regionOverlays, binMid)
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = autoBarWidth(binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const fwd = bin.forward != null ? bin.forward : Math.max(0, bin.value)
          const rev = bin.reverse != null ? bin.reverse : Math.min(0, bin.value)
          if (fwd > 0) {
            const ratio = useLog ? logScale(fwd, posMax) : fwd / posMax
            ctx.fillStyle = override || fwdColor; ctx.fillRect(x, midY - ratio * topH, w, ratio * topH)
          }
          if (rev < 0) {
            const ratio = useLog ? logScale(Math.abs(rev), negMax) : Math.abs(rev) / negMax
            ctx.fillStyle = override || revColor; ctx.fillRect(x, midY, w, ratio * botH)
          }
        }
      }

      if (showOutline && data.bins.length > 0) {
        const fwdStroke = outlineColor || theme.textPrimary || '#fff'
        const revStroke = outlineColor || theme.textPrimary || '#fff'
        // Compute smoothed Y values
        const fwdRaw = data.bins.map(b => { const v = b.forward != null ? b.forward : Math.max(0, b.value); return v > 0 ? (useLog ? logScale(v, posMax) : v / posMax) : 0 })
        const revRaw = data.bins.map(b => { const v = b.reverse != null ? b.reverse : Math.min(0, b.value); return v < 0 ? (useLog ? logScale(Math.abs(v), negMax) : Math.abs(v) / negMax) : 0 })
        const fwdSmooth = smoothValues(fwdRaw, outlineSmooth)
        const revSmooth = smoothValues(revRaw, outlineSmooth)
        const xs = data.bins.map(b => ((b.start + b.end) / 2 - regionStart) / regionLen * width)
        drawSmoothLine(ctx, xs, fwdSmooth.map(r => midY - r * topH), fwdStroke, outlineSmooth > 0)
        drawSmoothLine(ctx, xs, revSmooth.map(r => midY + r * botH), revStroke, outlineSmooth > 0)
      }
      ctx.globalAlpha = 1

      if (!isOverlayLayer) {
        const scaleLabel = useLog ? ' log\u2082' : ''
        drawScaleLabel(ctx, `+${posMax.toFixed(1)}${scaleLabel}`, 2, 2, theme)
        drawScaleLabel(ctx, `\u2212${negMax.toFixed(1)}${scaleLabel}`, 2, height - 12, theme)
        drawScaleLabel(ctx, '0', 2, midY - 6, theme, true)
      }
    } else {
      const effectiveMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
      ctx.globalAlpha = barAlpha
      if (showBars) {
        for (const bin of data.bins) {
          const binMid = (bin.start + bin.end) / 2
          const override = getRegionBarColor(regionOverlays, binMid)
          ctx.fillStyle = override || fwdColor
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = autoBarWidth(binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const ratio = useLog ? logScale(bin.value, effectiveMax) : bin.value / effectiveMax
          const barH = ratio * (height - 14)
          ctx.fillRect(x, height - barH - 2, w, barH)
        }
      }
      if (showOutline && data.bins.length > 0) {
        const rawRatios = data.bins.map(b => useLog ? logScale(b.value, effectiveMax) : b.value / effectiveMax)
        const smoothed = smoothValues(rawRatios, outlineSmooth)
        const xs = data.bins.map(b => ((b.start + b.end) / 2 - regionStart) / regionLen * width)
        const ys = smoothed.map(r => height - r * (height - 14) - 2)
        drawSmoothLine(ctx, xs, ys, outlineColor || theme.textPrimary || '#fff', outlineSmooth > 0)
      }
      ctx.globalAlpha = 1

      if (!isOverlayLayer) {
        const scaleLabel = useLog ? ' log\u2082' : ''
        drawScaleLabel(ctx, `${effectiveMax.toFixed(1)}${scaleLabel}`, 2, 2, theme)
        drawScaleLabel(ctx, '0', 2, height - 12, theme, true)
      }
    }

    // Detect clipping warnings (and surface a refresh-failure as a warning
    // when stale data is being shown, so the user knows it isn't fresh).
    if (onWarning) {
      const warnings = []
      if (error) {
        const msg = typeof error === 'string' ? error : JSON.stringify(error)
        warnings.push(`Update failed: ${msg} — showing last loaded data`)
      }
      if (userScaleMax != null && maxVal > userScaleMax) {
        warnings.push(`Bars clipped: max value ${maxVal.toFixed(1)} exceeds scale ${userScaleMax.toFixed(1)}`)
      }
      if (hasNegative && userScaleMin != null && Math.abs(minVal) > userScaleMin) {
        warnings.push(`Negative bars clipped: min value ${Math.abs(minVal).toFixed(1)} exceeds scale ${userScaleMin.toFixed(1)}`)
      }
      onWarning(warnings.length > 0 ? warnings.join('\n') : null)
    }
  }, [data, loading, error, width, height, region, track.color, track.scaleMax, track.scaleMin, track.logScale, track.barAutoWidth, track.barWidth, track.showOutline, track.outlineColor, track.outlineSmooth, track.showBars, track.regionOverlays, track.autoScaleVisible, track.linkScale, track.overlayGroup, overlayRole, barAlpha, overlayScaleMax, overlayScaleMin, overlayLogScale, liveVersion, tracks, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
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
