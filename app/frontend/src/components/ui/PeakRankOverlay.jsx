/**
 * PeakRankOverlay.jsx — Draws peak rank labels over coverage/read tracks.
 *
 * Reads ranked peaks published to PeakContext by peak annotation tracks and
 * paints each peak's rank number near the top of the track, centered over the
 * peak's position. Higher-ranked (more enriched) peaks win when labels would
 * collide, so the overlay stays readable when peaks are close or zoomed out.
 */
import React, { useRef, useEffect, useMemo } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { usePeaks } from '../../store/PeakContext'

const LABEL_COLOR = '#ffd54f'      // enrichment-rank accent (amber)
const PILL_BG = 'rgba(0,0,0,0.6)'

export default function PeakRankOverlay({ width, height }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { peaksByTrack } = usePeaks()

  // Merge peaks from every peak track and de-dup by location, keeping the best
  // (lowest) rank when two tracks report a peak at the same spot.
  const peaks = useMemo(() => {
    const byLoc = new Map()
    for (const list of Object.values(peaksByTrack || {})) {
      for (const f of list) {
        if (f.rank == null) continue
        const key = `${f.start}-${f.end}`
        const prev = byLoc.get(key)
        if (!prev || f.rank < prev.rank) byLoc.set(key, f)
      }
    }
    return Array.from(byLoc.values())
  }, [peaksByTrack])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    if (!region || !peaks.length) return

    const regionLen = region.end - region.start
    if (regionLen <= 0) return

    // In-region peaks, most-enriched first so they get label priority.
    const visible = peaks
      .filter(f => f.end > region.start && f.start < region.end &&
        (f.chrom == null || f.chrom === region.chrom))
      .sort((a, b) => a.rank - b.rank)
    if (!visible.length) return

    ctx.font = 'bold 10px Arial, Helvetica, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const placed = []          // [x0, x1] ranges already used
    const labelY = 9
    for (const f of visible) {
      const mid = (f.start + f.end) / 2
      const cx = ((mid - region.start) / regionLen) * width
      if (cx < 0 || cx > width) continue
      const label = String(f.rank)
      const tw = ctx.measureText(label).width
      const halfW = tw / 2 + 4
      const x0 = cx - halfW, x1 = cx + halfW
      let collides = false
      for (const [p0, p1] of placed) { if (x1 > p0 && x0 < p1) { collides = true; break } }
      if (collides) continue
      placed.push([x0, x1])

      // pill background for legibility over the signal
      ctx.fillStyle = PILL_BG
      roundRect(ctx, x0, labelY - 7, x1 - x0, 14, 3)
      ctx.fill()
      // rank number
      ctx.fillStyle = LABEL_COLOR
      ctx.fillText(label, cx, labelY)
      // thin tick pointing down toward the peak in the signal below
      ctx.strokeStyle = 'rgba(255,213,79,0.55)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx, labelY + 7); ctx.lineTo(cx, Math.min(labelY + 13, height)); ctx.stroke()
    }
  }, [region, width, height, peaks])

  if (!peaks.length) return null
  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none', zIndex: 4 }}
    />
  )
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
