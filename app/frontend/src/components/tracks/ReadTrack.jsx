/**
 * ReadTrack.jsx — Canvas renderer for aligned reads (BAM).
 *
 * Shows coverage bars when zoomed out, individual read rectangles when
 * zoomed in (<50 kbp). When zoomed in, reads are drawn segment-by-segment
 * from parsed CIGAR data: matches (filled), deletions (thin line),
 * intron skips (dotted line), and insertions (purple tick marks at the
 * exact genomic position).
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData } from '../../hooks/useTrackData'

const READ_DETAIL_THRESHOLD = 50_000
const READ_HEIGHT = 8
const ROW_GAP = 2
const INSERTION_COLOR = '#9c27b0'

export default function ReadTrack({ track, width, height, onWarning }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()
  const { data, loading } = useTrackData(track, region, width)

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

    if (loading && !data) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (!data) { if (onWarning) onWarning(null); return }

    const regionStart = region.start
    const regionLen = region.end - region.start

    // ── Coverage mode (zoomed out) ──────────────────────────────
    if (data.bins) {
      const actualMax = data.max_value || 1
      const maxVal = track.scaleMax != null ? track.scaleMax : actualMax
      const color = track.color || '#78909c'
      const barAuto = track.barAutoWidth !== false
      const barFixedPx = track.barWidth || 2
      ctx.fillStyle = color
      for (const bin of data.bins) {
        const binW = ((bin.end - bin.start) / regionLen) * width
        const w = barAuto ? Math.max(1, binW) : Math.min(barFixedPx, binW)
        const x = ((bin.start - regionStart) / regionLen) * width
        const ratio = Math.min(1, bin.value / maxVal)
        const barH = ratio * (height - 14)
        ctx.fillRect(x, height - barH - 2, w, barH)
      }
      ctx.fillStyle = theme.textSecondary; ctx.font = '10px Arial, Helvetica, sans-serif'; ctx.fillText(maxVal.toFixed(1), 2, 10)
      ctx.fillStyle = '#ffb74d'; ctx.font = '10px Arial, Helvetica, sans-serif'; ctx.textAlign = 'right'
      ctx.fillText('zoom in for reads', width - 4, 10)
      if (onWarning) {
        onWarning(track.scaleMax != null && actualMax > track.scaleMax
          ? `Bars clipped: max value ${actualMax.toFixed(1)} exceeds scale ${track.scaleMax.toFixed(1)}`
          : null)
      }
      return
    }

    // ── Read detail mode (zoomed in) ────────────────────────────
    if (!data.reads?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('No reads in region', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }

    const toX = (pos) => ((pos - regionStart) / regionLen) * width
    const pxPerBp = width / regionLen

    let hiddenReads = 0
    for (const read of data.reads) {
      const y = read.row * (READ_HEIGHT + ROW_GAP) + 2
      if (y + READ_HEIGHT > height) { hiddenReads++; continue }

      const readColor = read.strand === '+' ? '#90a4ae' : '#f06292'
      const segments = read.segments

      if (segments && segments.length > 0) {
        // ── CIGAR-aware rendering ─────────────────────────────

        // 1) Thin connector line across full read span
        const x0 = toX(read.start)
        const x1 = toX(read.end)
        ctx.strokeStyle = readColor
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x0, y + READ_HEIGHT / 2)
        ctx.lineTo(x1, y + READ_HEIGHT / 2)
        ctx.stroke()

        // 2) Draw each CIGAR segment
        for (const seg of segments) {
          if (seg.type === 'M') {
            // Match/mismatch — filled rectangle
            const sx = toX(seg.start)
            const sw = Math.max(1, toX(seg.end) - sx)
            ctx.fillStyle = readColor
            ctx.fillRect(sx, y, sw, READ_HEIGHT)

          } else if (seg.type === 'D') {
            // Deletion — gap in the read body, thin line through center
            const sx = toX(seg.start)
            const sw = toX(seg.end) - sx
            if (sw >= 1) {
              ctx.strokeStyle = readColor
              ctx.lineWidth = 1
              ctx.beginPath()
              ctx.moveTo(sx, y + READ_HEIGHT / 2)
              ctx.lineTo(sx + sw, y + READ_HEIGHT / 2)
              ctx.stroke()
            }

          } else if (seg.type === 'N') {
            // Intron skip — dotted line
            const sx = toX(seg.start)
            const sw = toX(seg.end) - sx
            if (sw >= 2) {
              ctx.setLineDash([2, 2])
              ctx.strokeStyle = readColor
              ctx.lineWidth = 1
              ctx.beginPath()
              ctx.moveTo(sx, y + READ_HEIGHT / 2)
              ctx.lineTo(sx + sw, y + READ_HEIGHT / 2)
              ctx.stroke()
              ctx.setLineDash([])
            }

          } else if (seg.type === 'I') {
            // Insertion — purple tick at exact genomic position
            const ix = toX(seg.pos)
            const tickW = Math.max(2, Math.min(4, pxPerBp * 0.4))
            ctx.fillStyle = INSERTION_COLOR
            ctx.fillRect(ix - tickW / 2, y - 1, tickW, READ_HEIGHT + 2)
          }
        }
      } else {
        // Fallback: no CIGAR segments, draw simple rectangle
        const x = toX(read.start)
        const w = Math.max(2, toX(read.end) - x)
        ctx.fillStyle = readColor
        ctx.fillRect(x, y, w, READ_HEIGHT)
      }

      // Strand arrow overlay
      const rx = toX(read.start)
      const rw = Math.max(2, toX(read.end) - rx)
      const arrowSize = Math.min(4, rw / 2)
      if (arrowSize >= 2) {
        ctx.fillStyle = theme.canvasBg
        if (read.strand === '+') {
          ctx.beginPath(); ctx.moveTo(rx + rw, y + READ_HEIGHT / 2)
          ctx.lineTo(rx + rw - arrowSize, y); ctx.lineTo(rx + rw - arrowSize, y + READ_HEIGHT); ctx.fill()
        } else {
          ctx.beginPath(); ctx.moveTo(rx, y + READ_HEIGHT / 2)
          ctx.lineTo(rx + arrowSize, y); ctx.lineTo(rx + arrowSize, y + READ_HEIGHT); ctx.fill()
        }
      }

      // Read name when zoomed in enough
      if (rw > 60) {
        ctx.fillStyle = theme.canvasBg; ctx.font = '8px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'
        ctx.fillText(read.name.slice(0, 20), rx + 2, y + READ_HEIGHT - 1)
      }
    }

    if (onWarning) {
      onWarning(hiddenReads > 0
        ? `${hiddenReads} read${hiddenReads > 1 ? 's' : ''} hidden \u2014 increase track height to show all`
        : null)
    }
  }, [data, loading, width, height, region, track.color, track.scaleMax, track.scaleMin, track.barAutoWidth, track.barWidth, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
}
