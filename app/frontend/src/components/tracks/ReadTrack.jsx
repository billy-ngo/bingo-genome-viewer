/**
 * ReadTrack.jsx — Canvas renderer for aligned reads (BAM).
 *
 * Shows coverage bars when zoomed out, individual read rectangles when
 * zoomed in (<50 kbp). Supports strand coloring and pileup row layout.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData } from '../../hooks/useTrackData'

const READ_DETAIL_THRESHOLD = 50_000
const READ_HEIGHT = 8
const ROW_GAP = 2

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

    const regionLen = region.end - region.start

    if (data.bins) {
      const actualMax = data.max_value || 1
      const maxVal = track.scaleMax != null ? track.scaleMax : actualMax
      const color = track.color || '#78909c'
      const barAuto = track.barAutoWidth !== false
      const barFixedPx = track.barWidth || 2
      const pxPerNt = width / regionLen
      ctx.fillStyle = color
      for (const bin of data.bins) {
        const binW = ((bin.end - bin.start) / regionLen) * width
        const autoW = Math.max(1, Math.min(pxPerNt, binW))
        const w = barAuto ? autoW : Math.min(barFixedPx, binW)
        const x = ((bin.start - region.start) / regionLen) * width
        ctx.fillRect(x, height - (bin.value / maxVal) * (height - 14) - 2, w, (bin.value / maxVal) * (height - 14))
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

    if (!data.reads?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('No reads in region', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }

    let hiddenReads = 0
    for (const read of data.reads) {
      const x = ((read.start - region.start) / regionLen) * width
      const w = Math.max(2, ((read.end - read.start) / regionLen) * width)
      const y = read.row * (READ_HEIGHT + ROW_GAP) + 2
      if (y + READ_HEIGHT > height) { hiddenReads++; continue }

      ctx.fillStyle = read.strand === '+' ? '#90a4ae' : '#f06292'
      ctx.fillRect(x, y, w, READ_HEIGHT)

      const arrowSize = Math.min(4, w / 2)
      ctx.fillStyle = theme.canvasBg
      if (read.strand === '+') {
        ctx.beginPath(); ctx.moveTo(x + w, y + READ_HEIGHT / 2)
        ctx.lineTo(x + w - arrowSize, y); ctx.lineTo(x + w - arrowSize, y + READ_HEIGHT); ctx.fill()
      } else {
        ctx.beginPath(); ctx.moveTo(x, y + READ_HEIGHT / 2)
        ctx.lineTo(x + arrowSize, y); ctx.lineTo(x + arrowSize, y + READ_HEIGHT); ctx.fill()
      }

      if (w > 60) {
        ctx.fillStyle = theme.canvasBg; ctx.font = '8px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'
        ctx.fillText(read.name.slice(0, 20), x + 2, y + READ_HEIGHT - 1)
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
