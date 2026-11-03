/**
 * PeakRankOverlay.jsx — Draws peak rank labels over coverage/read tracks.
 *
 * Reads ranked peaks published to PeakContext by peak annotation tracks and
 * paints each peak's rank number near the top of the track, centered over the
 * peak's position. Higher-ranked (more enriched) peaks win when labels would
 * collide, so the overlay stays readable when peaks are close or zoomed out.
 * The SVG/PNG export places the same labels (mergedPeaks, placePeakLabels).
 */
import React, { useRef, useEffect, useMemo } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { usePeaks } from '../../store/PeakContext'

export const LABEL_COLOR = '#ffd54f'      // enrichment-rank accent (amber)
export const LABEL_FONT = 'bold 10px Arial, Helvetica, sans-serif'
export const LABEL_Y = 9                  // centre line of the labels
const PILL_BG = 'rgba(0,0,0,0.6)'

/** The peaks of every peak track, de-duplicated by location: the best
 *  (lowest) rank wins when two tracks report a peak at the same spot. */
export function mergedPeaks(peaksByTrack) {
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
}

/** The rank labels over a track `width` px wide showing `region`: the
 *  peaks in view, most enriched first, each skipped when its pill would
 *  overlap one already placed. `measure(text)` is the label's width in
 *  LABEL_FONT. Returns [{ label, cx, x0, x1 }] (the pill spans x0..x1). */
export function placePeakLabels(peaks, region, width, measure) {
  const regionLen = region ? region.end - region.start : 0
  if (!peaks.length || regionLen <= 0) return []
  const visible = peaks
    .filter(f => f.end > region.start && f.start < region.end &&
      (f.chrom == null || f.chrom === region.chrom))
    .sort((a, b) => a.rank - b.rank)
  const placed = []
  for (const f of visible) {
    const cx = (((f.start + f.end) / 2 - region.start) / regionLen) * width
    if (cx < 0 || cx > width) continue
    const label = String(f.rank)
    const halfW = measure(label) / 2 + 4
    const x0 = cx - halfW, x1 = cx + halfW
    if (placed.some(p => x1 > p.x0 && x0 < p.x1)) continue
    placed.push({ label, cx, x0, x1 })
  }
  return placed
}

export default function PeakRankOverlay({ width, height }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { peaksByTrack } = usePeaks()
  const peaks = useMemo(() => mergedPeaks(peaksByTrack), [peaksByTrack])

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

    ctx.font = LABEL_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const { label, cx, x0, x1 } of placePeakLabels(peaks, region, width, t => ctx.measureText(t).width)) {
      // pill background for legibility over the signal
      ctx.fillStyle = PILL_BG
      roundRect(ctx, x0, LABEL_Y - 7, x1 - x0, 14, 3)
      ctx.fill()
      // rank number
      ctx.fillStyle = LABEL_COLOR
      ctx.fillText(label, cx, LABEL_Y)
      // thin tick pointing down toward the peak in the signal below
      ctx.strokeStyle = 'rgba(255,213,79,0.55)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx, LABEL_Y + 7); ctx.lineTo(cx, Math.min(LABEL_Y + 13, height)); ctx.stroke()
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
