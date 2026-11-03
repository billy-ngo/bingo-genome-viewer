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
import { binHigh, windowingOf, formatValue, coverageStyle, coverageAxis, clipWarnings } from '../../utils/coverageStats'
import { axisRatio, drawPending, shadePending, LOG_LABEL } from './CoverageTrack'

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

  // Read-view row geometry, shared by the draw, the Shift+wheel handler and
  // the scrollbar so they agree on how far the pileup scrolls: at the last
  // scroll position the last row ends at the bottom edge, and a pileup whose
  // rows all fit does not scroll at all. Bases (and the taller rows they need)
  // are drawn only when they fit, not merely because a reference sequence is
  // loaded: it is fetched for every view up to 2 kb.
  const pxPerBp = region ? width / (region.end - region.start) : 0
  const showBases = useMemo(
    () => showNucleotides && pxPerBp >= NUCL_PX_THRESHOLD && refSeq != null,
    [showNucleotides, pxPerBp, refSeq])
  const rows = useMemo(() => {
    const rh = showBases ? NUCL_READ_HEIGHT : READ_HEIGHT
    let maxRow = -1
    for (const r of visibleReads || []) if (r.row > maxRow) maxRow = r.row
    const totalRows = maxRow + 1
    const visibleRows = Math.floor(height / (rh + ROW_GAP))
    return { rh, totalRows, visibleRows, maxScroll: Math.max(0, totalRows - visibleRows) }
  }, [showBases, visibleReads, height])

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

  // Shift+wheel scrolls the pileup in read detail mode; a plain wheel is left
  // to the global useCanvasInteraction handler, which zooms. The listener is
  // attached natively as non-passive, like that one: React registers wheel
  // listeners as passive, where preventDefault is ignored (and Chrome logs an
  // error on every tick). It reads the current rows through a ref.
  const wheelRef = useRef(null)
  wheelRef.current = { rows, hasReads: !!visibleReads?.length }
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    function onWheel(e) {
      const { rows: { maxScroll }, hasReads } = wheelRef.current
      if (!hasReads || !e.shiftKey || maxScroll <= 0) return
      e.preventDefault()
      e.stopPropagation()
      // Step from the row drawn now (the draw clamps scrollRow to maxScroll).
      setScrollRow(prev => Math.max(0, Math.min(maxScroll, Math.min(prev, maxScroll) + Math.sign(e.deltaY) * 3)))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

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
      // Smooth fill replaces the bars with a single-colour area under the
      // (smoothed) outline curve, so the bars are off while it's on.
      const { bars: drawBars, fill: fillArea, outline: showOutline, smoothBp: sm } = coverageStyle(track)
      // The axis by CoverageTrack's rule (coverageAxis): the auto scale of the
      // track's link group, or the smoothed curve when that is all that is
      // drawn, unless a fixed scale is set. A read track never splits (+/−).
      const axis = coverageAxis(track, data.bins, region, {
        auto: computeAutoScale(track, region, tracks),
        grouped: !!track.linkScale,
        scaleMax: track.scaleMax != null ? track.scaleMax : null,
      })
      const maxVal = axis.max
      const curve = axis.curveHi
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
      if (curve && data.bins.length > 0) {
        const xs = data.bins.map(b => ((b.start + b.end) / 2 - regionStart) / regionLen * width)
        const ys = curve.map(v => height - axisRatio(v, maxVal, useLog) * (height - 14) - 2)
        if (fillArea) drawFilledArea(ctx, xs, ys, height - 2, color, sm > 0)
        if (showOutline) {
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

      const scaleLabel = (useLog ? LOG_LABEL : '') + (axis.smoothed ? ' smoothed' : '')
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
        // Clipping is judged on what is drawn: the bars, or the curve alone.
        warnings.push(...clipWarnings(track, data.bins, axis, region, { scaleMax: track.scaleMax != null ? track.scaleMax : null }))
        onWarning(warnings.length ? warnings.join('\n') : null)
      }
      return
    }

    // ── Read detail mode (zoomed in) ────────────────────────────
    const toX = (pos) => ((pos - regionStart) / regionLen) * width
    // When the backend's read-scan limit is reached (total_exact false), every
    // read overlapping the view and starting before scanned_to was found (the
    // pileup is an even sample of them when there are more than it returns),
    // but the rest of the view was not scanned. That part is shaded like
    // coverage not computed yet, so it never reads as a stretch without reads.
    // (Without scanned_to, i.e. an older backend, the last read start bounds
    // the scanned part.) Both the shade and the badge describe the data's own
    // range: right after a pan or zoom it is still the previous view's.
    const limited = data.total_exact === false
    const dataStart = Number.isFinite(data.start) ? data.start : regionStart
    const dataEnd = Number.isFinite(data.end) ? data.end : region.end
    const scannedTo = !limited ? null
      : Number.isFinite(data.scanned_to) ? data.scanned_to
      : (data.reads || []).reduce((m, r) => Math.max(m, r.start), dataStart)
    const clampX = (x) => Math.max(0, Math.min(width, x))
    const unscannedX0 = limited ? clampX(toX(Math.max(scannedTo, dataStart))) : width
    const unscannedX1 = limited ? clampX(toX(dataEnd)) : width
    const shadeUnscanned = () => {
      if (unscannedX1 > unscannedX0) shadePending(ctx, unscannedX0, unscannedX1, height, theme)
    }
    const limitWarning = limited ? readLimitWarning(data, scannedTo, dataStart, visibleReads?.length || 0) : null
    /** Draw `msg` over the part [x0, x1] of the canvas it describes, cut to
     *  it; nothing when that part is (all but) off-screen — as right after a
     *  jump, before the new view's reads have loaded. */
    const textIn = (msg, x0, x1) => {
      if (x1 - x0 < 16) return
      ctx.save()
      ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, height); ctx.clip()
      ctx.fillText(msg, x0 + 8, height / 2 + 4)
      ctx.restore()
    }

    if (!data.reads?.length || !visibleReads?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      shadeUnscanned()
      // The messages about the data describe its own range (dataX0..dataX1).
      const dataX0 = clampX(toX(dataStart)), dataX1 = clampX(toX(dataEnd))
      if (data.reads?.length && !(showFwd || showRev)) {
        ctx.fillText('All strands hidden — enable forward or reverse in Track Settings', 8, height / 2 + 4)
      } else if (data.reads?.length) {
        textIn(`No ${showFwd ? 'forward' : 'reverse'}-strand reads here — the ${showFwd ? 'reverse' : 'forward'} strand is hidden in Track Settings`, dataX0, dataX1)
      } else if (limited) {
        textIn('Too many reads to scan here', unscannedX0, unscannedX1)   // the scan stopped before any read
      } else {
        textIn('No reads in region', dataX0, dataX1)
      }
      if (onWarning) {
        const warnings = []
        if (error) warnings.push(`Update failed: ${error} — showing last loaded data`)
        if (limitWarning) warnings.push(limitWarning)
        onWarning(warnings.length ? warnings.join('\n') : null)
      }
      reportAuto(0)
      return
    }

    const { rh, totalRows, visibleRows, maxScroll } = rows
    const rg = ROW_GAP

    // Height needed to show every row (top pad + rows + bottom pad). The panel
    // clamps this to [default, 500]; deeper pileups keep the scrollbar.
    reportAuto(2 + totalRows * (rh + rg) + 4)
    const needsScroll = totalRows > visibleRows
    canvas.dataset.scrollbar = needsScroll ? String(SCROLLBAR_WIDTH) : '0'
    const trackW = needsScroll ? width - SCROLLBAR_WIDTH - 2 : width
    const safeScrollRow = Math.min(scrollRow, maxScroll)

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
    // The part of the view the read-scan limit left unscanned.
    shadeUnscanned()

    // ── Vertical scrollbar ──────────────────────────────────────
    if (needsScroll) {
      const sbX = width - SCROLLBAR_WIDTH
      // Track background
      ctx.fillStyle = theme.inputBg || '#2a2a2a'
      ctx.fillRect(sbX, 0, SCROLLBAR_WIDTH, height)
      // Thumb
      const thumbFrac = visibleRows / totalRows
      const thumbH = Math.max(20, thumbFrac * height)
      // At the last scroll position the thumb sits at the bottom.
      const scrollFrac = maxScroll > 0 ? safeScrollRow / maxScroll : 0
      const thumbY = scrollFrac * (height - thumbH)
      ctx.fillStyle = '#555'
      ctx.fillRect(sbX + 1, thumbY, SCROLLBAR_WIDTH - 2, thumbH)
    }

    if (onWarning) {
      const warnings = []
      if (error) warnings.push(`Update failed: ${error} — showing last loaded data`)
      if (limitWarning) {
        warnings.push(limitWarning)
      } else if (data.truncated) {
        // With an exact total the pileup is an even sample of every read
        // overlapping the view; past the scan limit it is not (above).
        warnings.push(`Showing ${data.reads.length.toLocaleString()} of ${(data.total || 0).toLocaleString()} reads ` +
          '(downsampled evenly across the view) — zoom in to see all')
      }
      if (hiddenReads > 0 && !needsScroll) {
        warnings.push(`${hiddenReads.toLocaleString()} read${hiddenReads > 1 ? 's' : ''} hidden \u2014 increase track height to show all`)
      } else if (needsScroll) {
        warnings.push(`${totalRows.toLocaleString()} rows · Shift+scroll or drag scrollbar to navigate`)
      }
      onWarning(warnings.length ? warnings.join('\n') : null)
    }
  }, [data, error, visibleReads, loading, width, height, region, refSeq, showBases, rows, scrollRow, track.color, track.scaleMax, track.scaleMin,
      track.barAutoWidth, track.barWidth, track.showOutline, track.outlineColor, track.smoothBp, track.showBars, track.fillArea,
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

    const { totalRows, visibleRows, maxScroll } = rows
    if (maxScroll <= 0) return

    // Stop propagation so the global useCanvasInteraction pan handler
    // doesn't also start a pan when the user grabs the scrollbar.
    e.preventDefault()
    e.stopPropagation()
    // Start from the row drawn now (the draw clamps scrollRow to maxScroll).
    // The thumb follows the cursor: its travel (the bar less the thumb, as
    // drawn) spans every scroll position.
    const travel = Math.max(1, height - Math.max(20, (visibleRows / totalRows) * height))
    scrollDragRef.current = { maxScroll, travel, startY: e.clientY, startRow: Math.min(scrollRow, maxScroll) }

    function onMove(ev) {
      if (!scrollDragRef.current) return
      const dy = ev.clientY - scrollDragRef.current.startY
      const rowDelta = Math.round((dy / scrollDragRef.current.travel) * scrollDragRef.current.maxScroll)
      setScrollRow(Math.max(0, Math.min(scrollDragRef.current.maxScroll, scrollDragRef.current.startRow + rowDelta)))
    }
    function onUp() {
      scrollDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [visibleReads, width, height, scrollRow, rows])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height }}
      onMouseDown={onMouseDown}
    />
  )
}

/** The badge text for a read view the backend's read-scan limit cut short.
 *  Every read overlapping the view (`viewStart` on) and starting before
 *  `scannedTo` was found: `total` of them (a lower bound on the reads
 *  overlapping the view), of which `data.reads` is an even sample when there
 *  are more than the backend returns, and `drawn` pass the strand filter. At
 *  or before the view start the limit was spent on reads just left of the
 *  view, before reaching it; zooming in does not help there (those reads lie
 *  in the same 16 kb index window), while the coverage view still shows the
 *  depth. */
function readLimitWarning(data, scannedTo, viewStart, drawn) {
  const n = data.reads?.length || 0
  const leading = scannedTo <= viewStart
  if (n === 0) {
    return leading
      ? 'Read limit reached: too many reads just left of this view to scan (shaded part not scanned) — zoom out for coverage'
      : `Read limit reached: no reads up to ${scannedTo.toLocaleString()} (shaded part not scanned) — zoom in to see all`
  }
  const found = Math.max(n, data.total || 0)
  const parts = [`${found.toLocaleString()} read${found > 1 ? 's' : ''} found ` +
    (leading ? 'crossing the view start' : `up to ${scannedTo.toLocaleString()}`)]
  if (n < found) parts.push(`showing an even sample of ${n.toLocaleString()}`)
  if (drawn < n) parts.push(`${(n - drawn).toLocaleString()} of ${n < found ? 'the sample' : 'them'} on a hidden strand`)
  return `Read limit reached: ${parts.join(', ')} (shaded part not scanned) — ` +
    (leading ? 'zoom out for coverage' : 'zoom in to see all')
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
