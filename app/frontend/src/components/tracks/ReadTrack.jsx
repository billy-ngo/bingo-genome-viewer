/**
 * ReadTrack.jsx — Canvas renderer for aligned reads (BAM).
 *
 * Shows coverage bars when zoomed out, individual read rectangles when
 * zoomed in (<50 kbp). When zoomed in further, renders individual
 * nucleotides with mismatch highlighting against the reference.
 */
import React, { useRef, useEffect, useState } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData } from '../../hooks/useTrackData'
import { genomeApi } from '../../api/client'

const READ_DETAIL_THRESHOLD = 50_000
const NUCL_PX_THRESHOLD = 6  // min px/bp to show nucleotide letters
const READ_HEIGHT = 8
const NUCL_READ_HEIGHT = 14  // taller rows when showing nucleotides
const ROW_GAP = 2
const INSERTION_COLOR = '#9c27b0'

const BASE_COLORS = { A: '#4caf50', T: '#f44336', C: '#2196f3', G: '#ff9800', N: '#9e9e9e' }
const MISMATCH_BG = '#ffeb3b'

export default function ReadTrack({ track, width, height, onWarning }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()
  const { data, loading } = useTrackData(track, region, width)
  const [refSeq, setRefSeq] = useState(null)  // { chrom, start, end, sequence }
  const refFetchRef = useRef(null)

  const showNucleotides = track.showNucleotides !== false
  const useArrows = track.useArrows !== false

  // Fetch reference sequence when zoomed in enough for nucleotide display
  useEffect(() => {
    if (!region || !showNucleotides) { setRefSeq(null); return }
    const regionLen = region.end - region.start
    const pxPerBp = width / regionLen
    if (pxPerBp < NUCL_PX_THRESHOLD || regionLen > 2000) { setRefSeq(null); return }

    // Check if we already have the ref for this region
    if (refSeq && refSeq.chrom === region.chrom &&
        refSeq.start <= region.start && refSeq.end >= region.end) return

    // Fetch with some overscan
    const fetchStart = Math.max(0, region.start - 500)
    const fetchEnd = region.end + 500
    const key = `${region.chrom}:${fetchStart}-${fetchEnd}`
    if (refFetchRef.current === key) return
    refFetchRef.current = key

    genomeApi.sequence(region.chrom, fetchStart, fetchEnd)
      .then(res => {
        setRefSeq({ chrom: region.chrom, start: fetchStart, end: fetchEnd, sequence: res.data.sequence })
      })
      .catch(() => {})
  }, [region?.chrom, region?.start, region?.end, width, showNucleotides])

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
      const pxPerNt = width / regionLen
      if (track.showBars !== false) {
        ctx.fillStyle = color
        for (const bin of data.bins) {
          const binW = ((bin.end - bin.start) / regionLen) * width
          const w = barAuto
            ? (pxPerNt >= 1 ? Math.max(1, Math.min(pxPerNt, binW)) : Math.max(1, binW))
            : Math.min(barFixedPx, binW)
          const x = ((bin.start - regionStart) / regionLen) * width
          const ratio = Math.min(1, bin.value / maxVal)
          const barH = ratio * (height - 14)
          ctx.fillRect(x, height - barH - 2, w, barH)
        }
      }
      if (track.showOutline && data.bins.length > 0) {
        ctx.beginPath()
        const baseline = height - 2
        ctx.moveTo(((data.bins[0].start - regionStart) / regionLen) * width, baseline)
        for (const bin of data.bins) {
          const x = ((bin.start - regionStart) / regionLen) * width
          const xEnd = ((bin.end - regionStart) / regionLen) * width
          const ratio = Math.min(1, bin.value / maxVal)
          const y = height - ratio * (height - 14) - 2
          ctx.lineTo(x, y); ctx.lineTo(xEnd, y)
        }
        ctx.lineTo(((data.bins[data.bins.length - 1].end - regionStart) / regionLen) * width, baseline)
        ctx.strokeStyle = track.outlineColor || theme.textPrimary || '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      drawLabel(ctx, maxVal.toFixed(1), 2, 2, theme)
      drawLabel(ctx, '0', 2, height - 12, theme, true)
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
    const showBases = showNucleotides && pxPerBp >= NUCL_PX_THRESHOLD && refSeq != null
    const rh = showBases ? NUCL_READ_HEIGHT : READ_HEIGHT
    const rg = ROW_GAP

    let hiddenReads = 0
    for (const read of data.reads) {
      const y = read.row * (rh + rg) + 2
      if (y + rh > height) { hiddenReads++; continue }

      const readColor = read.strand === '+' ? '#90a4ae' : '#f06292'
      const segments = read.segments

      if (segments && segments.length > 0) {
        // Thin connector line
        const x0 = toX(read.start)
        const x1 = toX(read.end)
        ctx.strokeStyle = readColor; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x0, y + rh / 2); ctx.lineTo(x1, y + rh / 2); ctx.stroke()

        // Draw each CIGAR segment
        let queryOffset = 0  // track position in read.sequence
        for (const seg of segments) {
          if (seg.type === 'M') {
            const sx = toX(seg.start)
            const sw = Math.max(1, toX(seg.end) - sx)
            ctx.fillStyle = readColor
            ctx.fillRect(sx, y, sw, rh)

            // Draw individual bases if zoomed in enough
            if (showBases && read.sequence) {
              const segLen = seg.end - seg.start
              for (let i = 0; i < segLen; i++) {
                const refPos = seg.start + i
                const bx = toX(refPos)
                const bw = toX(refPos + 1) - bx
                const queryBase = read.sequence[queryOffset + i] || ''
                const base = queryBase.toUpperCase()

                // Get reference base for mismatch detection
                let refBase = ''
                if (refSeq && refPos >= refSeq.start && refPos < refSeq.end) {
                  refBase = (refSeq.sequence[refPos - refSeq.start] || '').toUpperCase()
                }

                const isMismatch = refBase && base && base !== refBase && base !== 'N'

                // Mismatch highlight
                if (isMismatch) {
                  ctx.fillStyle = MISMATCH_BG
                  ctx.fillRect(bx, y, bw, rh)
                }

                // Draw base letter
                if (bw >= 6) {
                  ctx.fillStyle = isMismatch ? '#000' : (BASE_COLORS[base] || '#999')
                  ctx.font = `bold ${Math.min(11, bw - 1)}px monospace`
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'middle'
                  ctx.fillText(base, bx + bw / 2, y + rh / 2)
                }
              }
              queryOffset += segLen
            }
          } else if (seg.type === 'D') {
            const sx = toX(seg.start)
            const sw = toX(seg.end) - sx
            if (sw >= 1) {
              ctx.strokeStyle = readColor; ctx.lineWidth = 1
              ctx.beginPath(); ctx.moveTo(sx, y + rh / 2); ctx.lineTo(sx + sw, y + rh / 2); ctx.stroke()
            }
          } else if (seg.type === 'N') {
            const sx = toX(seg.start)
            const sw = toX(seg.end) - sx
            if (sw >= 2) {
              ctx.setLineDash([2, 2]); ctx.strokeStyle = readColor; ctx.lineWidth = 1
              ctx.beginPath(); ctx.moveTo(sx, y + rh / 2); ctx.lineTo(sx + sw, y + rh / 2); ctx.stroke()
              ctx.setLineDash([])
            }
          } else if (seg.type === 'I') {
            const ix = toX(seg.pos)
            ctx.fillStyle = INSERTION_COLOR
            ctx.fillRect(ix - 1, y - 1, 2, rh + 2)
            if (showBases) queryOffset += seg.length
          } else if (seg.type === 'S') {
            if (showBases) queryOffset += seg.length
          }
        }
      } else {
        // Fallback: no CIGAR segments
        const x = toX(read.start)
        const w = Math.max(2, toX(read.end) - x)
        ctx.fillStyle = readColor
        ctx.fillRect(x, y, w, rh)
      }

      // Strand arrow overlay (respects useArrows setting)
      if (useArrows) {
        const rx = toX(read.start)
        const rw = Math.max(2, toX(read.end) - rx)
        const arrowSize = Math.min(showBases ? 6 : 4, rw / 2)
        if (arrowSize >= 2) {
          ctx.fillStyle = theme.canvasBg
          if (read.strand === '+') {
            ctx.beginPath(); ctx.moveTo(rx + rw, y + rh / 2)
            ctx.lineTo(rx + rw - arrowSize, y); ctx.lineTo(rx + rw - arrowSize, y + rh); ctx.fill()
          } else {
            ctx.beginPath(); ctx.moveTo(rx, y + rh / 2)
            ctx.lineTo(rx + arrowSize, y); ctx.lineTo(rx + arrowSize, y + rh); ctx.fill()
          }
        }
      }

      // Read name — only when nucleotides are off and zoomed in enough
      if (!showBases && !showNucleotides) {
        const rx = toX(read.start)
        const rw = Math.max(2, toX(read.end) - rx)
        if (rw > 60) {
          ctx.fillStyle = theme.canvasBg; ctx.font = '8px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'
          ctx.fillText(read.name.slice(0, 20), rx + 2, y + rh - 1)
        }
      }
    }

    if (onWarning) {
      onWarning(hiddenReads > 0
        ? `${hiddenReads} read${hiddenReads > 1 ? 's' : ''} hidden \u2014 increase track height to show all`
        : null)
    }
  }, [data, loading, width, height, region, refSeq, track.color, track.scaleMax, track.scaleMin,
      track.barAutoWidth, track.barWidth, track.showOutline, track.outlineColor, track.showBars,
      track.showNucleotides, track.useArrows, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
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
