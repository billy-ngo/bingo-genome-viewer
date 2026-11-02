/**
 * RulerTrack.jsx — Genomic coordinate ruler rendered on a canvas.
 *
 * Draws labeled tick marks for the current viewport region.
 * Shows the selection highlight when a region is selected.
 * Supports drag panning and scroll zooming via useCanvasInteraction.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../store/BrowserContext'
import { useTheme } from '../store/ThemeContext'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import { rulerTicks } from '../utils/ruler'

const RULER_HEIGHT = 30

export default function RulerTrack({ width }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const { region, selection } = useBrowser()
  const { theme } = useTheme()

  useCanvasInteraction(containerRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !region) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = RULER_HEIGHT * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    const { start, end } = region
    const len = end - start

    ctx.clearRect(0, 0, width, RULER_HEIGHT)
    ctx.fillStyle = theme.canvasBg
    ctx.fillRect(0, 0, width, RULER_HEIGHT)

    // ── Selection highlight ────────────────────────────────────
    if (selection && selection.chrom === region.chrom) {
      const leftFrac = (selection.start - start) / len
      const rightFrac = (selection.end - start) / len
      const pxLeft = Math.max(0, leftFrac * width)
      const pxRight = Math.min(width, rightFrac * width)
      if (pxRight - pxLeft >= 1) {
        ctx.fillStyle = 'rgba(100, 181, 246, 0.25)'
        ctx.fillRect(pxLeft, 0, pxRight - pxLeft, RULER_HEIGHT)
        ctx.strokeStyle = 'rgba(100, 181, 246, 0.6)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(pxLeft, 0); ctx.lineTo(pxLeft, RULER_HEIGHT)
        ctx.moveTo(pxRight, 0); ctx.lineTo(pxRight, RULER_HEIGHT)
        ctx.stroke()
      }
    }

    // ── Tick marks ─────────────────────────────────────────────
    ctx.strokeStyle = theme.rulerTick
    ctx.fillStyle = theme.rulerLabel
    ctx.font = '10px Arial, Helvetica, sans-serif'
    ctx.textAlign = 'center'

    ctx.beginPath()
    ctx.moveTo(0, 20)
    ctx.lineTo(width, 20)
    ctx.lineWidth = 1
    ctx.stroke()

    for (const { x, label } of rulerTicks(start, end, width).ticks) {
      ctx.beginPath()
      ctx.moveTo(x, 14)
      ctx.lineTo(x, 20)
      ctx.stroke()
      ctx.fillText(label, x, 11)
    }
  }, [region, selection, width, theme])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} data-export-ruler="1" style={{ display: 'block', width: '100%', height: RULER_HEIGHT }} />
    </div>
  )
}
