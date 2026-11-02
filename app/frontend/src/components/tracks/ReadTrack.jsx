/**
 * ReadTrack.jsx — Canvas renderer for aligned reads (BAM).
 *
 * Shows coverage bars when zoomed out, individual read rectangles when
 * zoomed in (<50 kbp). Supports nucleotide-level rendering with mismatch
 * highlighting, vertical scrolling for deep pileups, and log2 scale.
 */
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTracks } from '../../store/TrackContext'
import { useTrackData, computeAutoScale, useLiveDataVersion } from '../../hooks/useTrackData'
import { useReferenceSequence } from '../../hooks/useReferenceSequence'
import { binHigh, binExtremes, windowingOf, formatValue } from '../../utils/coverageStats'
import { axisRatio, drawPending, LOG_LABEL, smoothValues } from './CoverageTrack'

const READ_DETAIL_THRESHOLD = 50_000
const NUCL_PX_THRESHOLD = 6
const READ_HEIGHT = 8
const NUCL_READ_HEIGHT = 14
const ROW_GAP = 2
const INSERTION_COLOR = '#9c27b0'
const SCROLLBAR_WIDTH = 14   // wider hit-area so the thumb is easy to grab

/** Greedy row packing — reads sorted by start, placed in lowest non-overlapping row. */
function repackRows(reads) {
  const out = reads.map(r => ({ ...r }))
  out.sort((a, b) => a.start - b.start)
  const rowEnds = []
  for (const r of out) {
    let placed = false
    for (let i = 0; i < rowEnds.length; i++) {
      if (r.start >= rowEnds[i]) { r.row = i; rowEnds[i] = r.end; placed = true; break }
    }
    if (!placed) { r.row = rowEnds.length; rowEnds.push(r.end) }
  }
  return out
}

const BASE_COLORS = { A: '#4caf50', T: '#f44336', C: '#2196f3', G: '#ff9800', N: '#9e9e9e' }
const MISMATCH_BG = '#ffeb3b'

export default function ReadTrack({ track, width, height, onWarning, onAutoHeight }) {
  // Report 0 when there are no stacked rows (coverage mode / no reads) so the
  // panel's auto-fit reverts to the default reads height.
  const reportAuto = (px) => { if (onAutoHeight) onAutoHeight(px) }
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()
  const { tracks } = useTracks()
  const { data, loading, error } = useTrackData(track, region, width)
  const [scrollRow, setScrollRow] = useState(0)
  const scrollDragRef = useRef(null)

  const showNucleotides = track.showNucleotides !== false
  const useArrows = track.useArrows !== false
  const useLog = track.logScale === true
  const fwdStrandColor = track.fwdColor || '#90a4ae'
  const revStrandColor = track.revColor || '#f06292'
  const arrowStyle = track.arrowStyle || 'pointed'
  const arrowSizePx = track.arrowSize || 4
  const showFwd = track.showFwdStrand !== false
  const showRev = track.showRevStrand !== false
  const refSeq = useReferenceSequence(region, showNucleotides)
  // A linked read track's axis depends on its siblings' data: redraw when it lands.
  const liveVersion = useLiveDataVersion(!!track.linkScale)

  // Filter by strand and repack rows so hidden strand doesn't leave gaps
  const visibleReads = useMemo(() => {
    if (!data?.reads?.length) return null
    if (showFwd && showRev) return data.reads
    const filtered = data.reads.filter(r =>
      (r.strand === '+' && showFwd) || (r.strand === '-' && showRev) ||
      (r.strand !== '+' && r.strand !== '-')  // unknown strand always shown
    )
    return repackRows(filtered)
  }, [data?.reads, showFwd, showRev])

  // Reset scroll when region changes significantly
  const prevRegionRef = useRef(null)
  useEffect(() => {
    if (region && prevRegionRef.current) {
      const prev = prevRegionRef.current
      if (prev.chrom !== region.chrom || Math.abs(prev.start - region.start) > (prev.end - prev.start)) {
        setScrollRow(0)
      }
    }
    prevRegionRef.current = region
  }, [region?.chrom, region?.start, region?.end])

  // Scroll handler for the track area (wheel in read detail mode).
  // Only takes over when Shift is held (or trackpad vertical-only gesture);
  // otherwise the global useCanvasInteraction handler does horizontal zoom.
  const onWheel = useCallback((e) => {
    if (!visibleReads?.length) return
    if (!e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
    if (!e.shiftKey) return  // Plain wheel → zoom (handled by useCanvasInteraction)
    const rh = (showNucleotides && refSeq) ? NUCL_READ_HEIGHT : READ_HEIGHT
    const maxRow = Math.max(0, ...visibleReads.map(r => r.row))
    const visibleRows = Math.floor(height / (rh + ROW_GAP))
    const maxScroll = Math.max(0, maxRow - visibleRows + 2)
    if (maxScroll <= 0) return
    e.preventDefault()
    e.stopPropagation()
    setScrollRow(prev => Math.max(0, Math.min(maxScroll, prev + Math.sign(e.deltaY) * 3)))
  }, [visibleReads, height, showNucleotides, refSeq])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = theme.canvasBg; ctx.fillRect(0, 0, width, height)
    // Reset the scrollbar-zone hint each draw; set below when a scrollbar is
    // shown. The global drag-to-scroll handler reads this to avoid hijacking
    // a press that lands on the read pileup's own scrollbar.
    canvas.dataset.scrollbar = '0'

    if (loading && !data) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (!data) { if (onWarning) onWarning(null); return }
    // Coverage mode and the empty/error states have no stacked rows \u2014 let the
    // panel auto-fit revert to the default reads height.
    if (data.bins) reportAuto(0)

    const regionStart = region.start
    const regionLen = region.end - region.start

    // ── Coverage mode (zoomed out) ──────────────────────────────
    if (data.bins) {
      // Depth per bin under the track's windowing function (Max by default:
      // the deepest base in each bin), with the axis from the same statistic.
      const windowing = windowingOf(track)
      const hi = (b) => binHigh(b, windowing)
      const color = track.color || '#78909c'
      const barAuto = track.barAutoWidth !== false
      const barFixedPx = track.barWidth || 2
      const pxPerNt = width / regionLen
      const fillArea = track.fillArea === true
      // Smooth fill replaces the bars with a single-colour area under the
      // (smoothed) outline curve, so suppress the bars while it's on.
      const drawBars = track.showBars !== false && !fillArea
      const wantCurve = fillArea || track.showOutline
      const sm = track.outlineSmooth || 0
      const curve = wantCurve ? smoothValues(data.bins.map(b => (b.pending ? 0 : hi(b))), sm) : null
      let actualMax = computeAutoScale(track, region, tracks).max || 1
      let smoothedAxis = false
      if (!drawBars && wantCurve && sm > 0 && !track.linkScale) {
        // The smoothed curve is the whole track: fit the axis to it (see CoverageTrack).
        const visibleOnly = track.autoScaleVisible !== false
        let m = 0
        data.bins.forEach((b, i) => {
          if (visibleOnly && (b.end <= region.start || b.start >= region.end)) return
          if (curve[i] > m) m = curve[i]
        })
        actualMax = m || 1
        smoothedAxis = true
      }
      const maxVal = track.scaleMax != null ? track.scaleMax : actualMax
      if (drawBars) {
        ctx.fillStyle = color
        for (const bin of data.bins) {
          if (bin.pending) continue
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = barAuto
            ? (pxPerNt >= 1 ? Math.max(1, Math.min(pxPerNt, binW)) : Math.max(1, binW))
            : Math.min(barFixedPx, binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const barH = axisRatio(hi(bin), maxVal, useLog) * (height - 14)
          ctx.fillRect(x, height - barH - 2, w, barH)
        }
      }
      // Smooth fill and/or peak outline share the same smoothed values so the
      // filled area and the stroke on top of it line up exactly.
      if (wantCurve && data.bins.length > 0) {
        const xs = data.bins.map(b => ((b.start + b.end) / 2 - regionStart) / regionLen * width)
        const ys = curve.map(v => height - axisRatio(v, maxVal, useLog) * (height - 14) - 2)
        if (fillArea) drawFilledArea(ctx, xs, ys, height - 2, color, sm > 0)
        if (track.showOutline) {
          const strokeColor = track.outlineColor || theme.textPrimary || '#fff'
          ctx.beginPath(); ctx.moveTo(xs[0], ys[0])
          if (sm > 0) {
            for (let i = 0; i < xs.length - 1; i++) ctx.quadraticCurveTo(xs[i], ys[i], (xs[i]+xs[i+1])/2, (ys[i]+ys[i+1])/2)
            ctx.lineTo(xs[xs.length-1], ys[ys.length-1])
          } else { for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]) }
          ctx.strokeStyle = strokeColor; ctx.lineWidth = 1.5; ctx.stroke()
        }
      }
      drawPending(ctx, data.bins, regionStart, regionLen, width, height, theme)

      const scaleLabel = (useLog ? LOG_LABEL : '') + (smoothedAxis && track.scaleMax == null ? ' smoothed' : '')
      drawLabel(ctx, `${formatValue(maxVal)}${scaleLabel}`, 2, 2, theme)
      drawLabel(ctx, '0', 2, height - 12, theme, true)
      ctx.fillStyle = '#ffb74d'; ctx.font = '10px Arial, Helvetica, sans-serif'; ctx.textAlign = 'right'
      ctx.fillText('zoom in for reads', width - 4, 10)
      if (onWarning) {
        const warnings = []
        if (error) warnings.push(`Update failed: ${error} \u2014 showing last loaded data`)
        if (data.complete === false) {
          warnings.push(`Computing exact coverage\u2026 ${Math.round(100 * (data.coverage_progress || 0))}% (shaded part pending)`)
        }
        if (data.truncated) warnings.push('Coverage incomplete at this zoom (read limit reached) \u2014 zoom in for exact values')
        const visMax = binExtremes(data.bins, windowing, region.start, region.end).max
        if (track.scaleMax != null && visMax > track.scaleMax) {
          warnings.push(`Bars clipped: visible max ${formatValue(visMax)} exceeds scale ${formatValue(track.scaleMax)}`)
        }
        onWarning(warnings.length ? warnings.join('\n') : null)
      }
      return
    }

    // ── Read detail mode (zoomed in) ────────────────────────────
    if (!data.reads?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('No reads in region', 8, height / 2 + 4)
      if (onWarning) onWarning(error ? `Update failed: ${error} — showing last loaded data` : null)
      reportAuto(0)
      return
    }
    if (!visibleReads?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('All strands hidden — enable forward or reverse in Track Settings', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      reportAuto(0)
      return
    }

    const toX = (pos) => ((pos - regionStart) / regionLen) * width
    const pxPerBp = width / regionLen
    const showBases = showNucleotides && pxPerBp >= NUCL_PX_THRESHOLD && refSeq != null
    const rh = showBases ? NUCL_READ_HEIGHT : READ_HEIGHT
    const rg = ROW_GAP

    // Calculate total rows and visible rows for scrolling
    const maxRow = Math.max(0, ...visibleReads.map(r => r.row))
    const totalRows = maxRow + 1
    // Height needed to show every row (top pad + rows + bottom pad). The panel
    // clamps this to [default, 500]; deeper pileups keep the scrollbar.
    reportAuto(2 + totalRows * (rh + rg) + 4)
    const visibleRows = Math.floor(height / (rh + rg))
    const needsScroll = totalRows > visibleRows
    canvas.dataset.scrollbar = needsScroll ? String(SCROLLBAR_WIDTH) : '0'
    const trackW = needsScroll ? width - SCROLLBAR_WIDTH - 2 : width
    const safeScrollRow = Math.min(scrollRow, Math.max(0, totalRows - visibleRows + 1))

    let hiddenReads = 0
    let drawnReads = 0
    for (const read of visibleReads) {
      const rowY = (read.row - safeScrollRow) * (rh + rg) + 2
      if (rowY + rh < 0 || rowY > height) { hiddenReads++; continue }

      const readColor = read.strand === '+' ? fwdStrandColor : revStrandColor
      const segments = read.segments

      if (segments && segments.length > 0) {
        const x0 = toX(read.start)
        const x1 = toX(read.end)
        ctx.strokeStyle = readColor; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x0, rowY + rh / 2); ctx.lineTo(x1, rowY + rh / 2); ctx.stroke()

        let queryOffset = 0
        for (const seg of segments) {
          if (seg.type === 'M') {
            const sx = toX(seg.start)
            const sw = Math.max(1, toX(seg.end) - sx)
            ctx.fillStyle = readColor
            ctx.fillRect(sx, rowY, sw, rh)
            if (showBases && read.sequence) {
              const segLen = seg.end - seg.start
              for (let i = 0; i < segLen; i++) {
                const refPos = seg.start + i
                const bx = toX(refPos)
                const bw = toX(refPos + 1) - bx
                const base = (read.sequence[queryOffset + i] || '').toUpperCase()
                let refBase = ''
                if (refSeq && refPos >= refSeq.start && refPos < refSeq.end)
                  refBase = (refSeq.sequence[refPos - refSeq.start] || '').toUpperCase()
                const isMismatch = refBase && base && base !== refBase && base !== 'N'
                if (isMismatch) { ctx.fillStyle = MISMATCH_BG; ctx.fillRect(bx, rowY, bw, rh) }
                if (bw >= 6) {
                  ctx.fillStyle = isMismatch ? '#000' : (BASE_COLORS[base] || '#999')
                  ctx.font = `bold ${Math.min(11, bw - 1)}px monospace`
                  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
                  ctx.fillText(base, bx + bw / 2, rowY + rh / 2)
                }
              }
              queryOffset += segLen
            }
          } else if (seg.type === 'D') {
            const sx = toX(seg.start); const sw = toX(seg.end) - sx
            if (sw >= 1) { ctx.strokeStyle = readColor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, rowY + rh / 2); ctx.lineTo(sx + sw, rowY + rh / 2); ctx.stroke() }
          } else if (seg.type === 'N') {
            const sx = toX(seg.start); const sw = toX(seg.end) - sx
            if (sw >= 2) { ctx.setLineDash([2, 2]); ctx.strokeStyle = readColor; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, rowY + rh / 2); ctx.lineTo(sx + sw, rowY + rh / 2); ctx.stroke(); ctx.setLineDash([]) }
          } else if (seg.type === 'I') {
            ctx.fillStyle = INSERTION_COLOR; ctx.fillRect(toX(seg.pos) - 1, rowY - 1, 2, rh + 2)
            if (showBases) queryOffset += seg.length
          } else if (seg.type === 'S') { if (showBases) queryOffset += seg.length }
        }
      } else {
        const x = toX(read.start)
        const w = Math.max(2, toX(read.end) - x)
        ctx.fillStyle = read.strand === '+' ? fwdStrandColor : revStrandColor
        ctx.fillRect(x, rowY, w, rh)
      }

      if (useArrows && arrowStyle !== 'flat') {
        const rx = toX(read.start); const rw = Math.max(2, toX(read.end) - rx)
        const as = Math.min(arrowSizePx, rw / 2)
        if (as >= 2) {
          drawReadArrow(ctx, arrowStyle, read.strand, rx, rowY, rw, rh, as, readColor, theme.canvasBg)
        }
      }

      if (!showBases && !showNucleotides) {
        const rx = toX(read.start); const rw = Math.max(2, toX(read.end) - rx)
        if (rw > 60) { ctx.fillStyle = theme.canvasBg; ctx.font = '8px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(read.name.slice(0, 20), rx + 2, rowY + rh - 1) }
      }
      drawnReads++
    }

    // ── Vertical scrollbar ──────────────────────────────────────
    if (needsScroll) {
      const sbX = width - SCROLLBAR_WIDTH
      // Track background
      ctx.fillStyle = theme.inputBg || '#2a2a2a'
      ctx.fillRect(sbX, 0, SCROLLBAR_WIDTH, height)
      // Thumb
      const thumbFrac = visibleRows / totalRows
      const thumbH = Math.max(20, thumbFrac * height)
      const scrollFrac = totalRows > visibleRows ? safeScrollRow / (totalRows - visibleRows) : 0
      const thumbY = scrollFrac * (height - thumbH)
      ctx.fillStyle = '#555'
      ctx.fillRect(sbX + 1, thumbY, SCROLLBAR_WIDTH - 2, thumbH)
    }

    if (onWarning) {
      const warnings = []
      if (error) warnings.push(`Update failed: ${error} — showing last loaded data`)
      if (data.truncated) {
        // The pileup is a uniform sample across the view (never just its left part).
        warnings.push(`Showing ${data.reads.length.toLocaleString()} of ${data.total_exact === false ? '≥' : ''}` +
          `${(data.total || 0).toLocaleString()} reads (downsampled evenly across the view) — zoom in to see all`)
      }
      if (hiddenReads > 0 && !needsScroll) {
        warnings.push(`${hiddenReads} read${hiddenReads > 1 ? 's' : ''} hidden \u2014 increase track height to show all`)
      } else if (needsScroll) {
        warnings.push(`${totalRows} rows · Shift+scroll or drag scrollbar to navigate`)
      }
      onWarning(warnings.length ? warnings.join('\n') : null)
    }
  }, [data, error, visibleReads, loading, width, height, region, refSeq, scrollRow, track.color, track.scaleMax, track.scaleMin,
      track.barAutoWidth, track.barWidth, track.showOutline, track.outlineColor, track.outlineSmooth, track.showBars, track.fillArea,
      track.windowing, track.showNucleotides, track.useArrows, track.logScale,
      track.fwdColor, track.revColor, track.arrowStyle, track.arrowSize,
      track.showFwdStrand, track.showRevStrand, track.autoScaleVisible, track.linkScale, liveVersion, tracks, theme])

  // Scrollbar drag handler
  const onMouseDown = useCallback((e) => {
    if (!visibleReads?.length) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (width / rect.width)
    if (mx < width - SCROLLBAR_WIDTH) return // not on scrollbar

    const rh = (showNucleotides && refSeq) ? NUCL_READ_HEIGHT : READ_HEIGHT
    const maxRow = Math.max(0, ...visibleReads.map(r => r.row))
    const totalRows = maxRow + 1
    const visibleRows = Math.floor(height / (rh + ROW_GAP))
    const maxScroll = Math.max(0, totalRows - visibleRows + 1)
    if (maxScroll <= 0) return

    // Stop propagation so the global useCanvasInteraction pan handler
    // doesn't also start a pan when the user grabs the scrollbar.
    e.preventDefault()
    e.stopPropagation()
    scrollDragRef.current = { maxScroll, startY: e.clientY, startRow: scrollRow }

    function onMove(ev) {
      if (!scrollDragRef.current) return
      const dy = ev.clientY - scrollDragRef.current.startY
      const rowDelta = Math.round((dy / height) * scrollDragRef.current.maxScroll)
      setScrollRow(Math.max(0, Math.min(scrollDragRef.current.maxScroll, scrollDragRef.current.startRow + rowDelta)))
    }
    function onUp() {
      scrollDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [visibleReads, width, height, scrollRow, showNucleotides, refSeq])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
    />
  )
}

/**
 * Draw a directional arrow indicator on a read.
 * Styles: 'pointed' (triangle cutout), 'chevron' (V notch), 'fade' (gradient)
 */
function drawReadArrow(ctx, style, strand, rx, ry, rw, rh, size, readColor, bgColor) {
  const isFwd = strand === '+'
  if (style === 'pointed') {
    // Triangle cutout at the tip (classic IGV style)
    ctx.fillStyle = bgColor
    if (isFwd) {
      ctx.beginPath(); ctx.moveTo(rx + rw, ry + rh / 2)
      ctx.lineTo(rx + rw - size, ry); ctx.lineTo(rx + rw - size, ry + rh); ctx.fill()
    } else {
      ctx.beginPath(); ctx.moveTo(rx, ry + rh / 2)
      ctx.lineTo(rx + size, ry); ctx.lineTo(rx + size, ry + rh); ctx.fill()
    }
  } else if (style === 'chevron') {
    // V-shaped notch at the tip
    ctx.strokeStyle = bgColor
    ctx.lineWidth = 1.5
    if (isFwd) {
      ctx.beginPath()
      ctx.moveTo(rx + rw - size, ry); ctx.lineTo(rx + rw, ry + rh / 2); ctx.lineTo(rx + rw - size, ry + rh)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(rx + size, ry); ctx.lineTo(rx, ry + rh / 2); ctx.lineTo(rx + size, ry + rh)
      ctx.stroke()
    }
  } else if (style === 'fade') {
    // Gradient fade at the tip
    if (isFwd) {
      const grad = ctx.createLinearGradient(rx + rw - size * 2, 0, rx + rw, 0)
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(1, bgColor)
      ctx.fillStyle = grad
      ctx.fillRect(rx + rw - size * 2, ry, size * 2, rh)
    } else {
      const grad = ctx.createLinearGradient(rx, 0, rx + size * 2, 0)
      grad.addColorStop(0, bgColor)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(rx, ry, size * 2, rh)
    }
  }
}

/** Fill the area between a (smooth or step) curve and a baseline with a flat
 *  colour, tracing the same top edge the outline stroke uses. */
function drawFilledArea(ctx, xs, ys, baseY, color, smooth) {
  if (xs.length < 2) return
  ctx.beginPath()
  ctx.moveTo(xs[0], baseY)
  ctx.lineTo(xs[0], ys[0])
  if (smooth) {
    for (let i = 0; i < xs.length - 1; i++) {
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2)
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

function drawLabel(ctx, text, x, y, theme, muted = false) {
  ctx.font = '10px Arial, Helvetica, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const pad = 2
  const tw = ctx.measureText(text).width + pad * 2
  ctx.fillStyle = theme.canvasBg || '#1e1e1e'
  ctx.globalAlpha = 0.75
  ctx.fillRect(x, y, tw, 12)
  ctx.globalAlpha = 1.0
  ctx.fillStyle = muted ? (theme.textTertiary || '#666') : (theme.textSecondary || '#aaa')
  ctx.fillText(text, x + pad, y + 1)
  ctx.textBaseline = 'alphabetic'
}
