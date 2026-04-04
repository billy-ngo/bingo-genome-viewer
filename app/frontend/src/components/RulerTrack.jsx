/**
 * RulerTrack.jsx — Genomic coordinate ruler rendered on a canvas.
 *
 * Draws labeled tick marks for the current viewport region.
 * Supports drag panning and scroll zooming via useCanvasInteraction.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../store/BrowserContext'
import { useTheme } from '../store/ThemeContext'

export default function RulerTrack({ width }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !region) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = 30 * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    const { start, end } = region
    const len = end - start

    ctx.clearRect(0, 0, width, 30)
    ctx.fillStyle = theme.canvasBg
    ctx.fillRect(0, 0, width, 30)

    const targetTicks = Math.min(10, Math.floor(width / 80))
    const rawInterval = len / targetTicks
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)))
    const candidates = [1, 2, 5, 10].map(x => x * magnitude)
    const interval = candidates.find(c => c >= rawInterval) || candidates[candidates.length - 1]
    const firstTick = Math.ceil(start / interval) * interval

    ctx.strokeStyle = theme.rulerTick
    ctx.fillStyle = theme.rulerLabel
    ctx.font = '10px Arial, Helvetica, sans-serif'
    ctx.textAlign = 'center'

    ctx.beginPath()
    ctx.moveTo(0, 20)
    ctx.lineTo(width, 20)
    ctx.lineWidth = 1
    ctx.stroke()

    for (let pos = firstTick; pos <= end; pos += interval) {
      const x = ((pos - start) / len) * width
      ctx.beginPath()
      ctx.moveTo(x, 14)
      ctx.lineTo(x, 20)
      ctx.stroke()
      ctx.fillText(formatBp(pos), x, 11)
    }
  }, [region, width, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 30 }} />
}

function formatBp(pos) {
  if (pos >= 1_000_000) return `${(pos / 1_000_000).toFixed(2)}M`
  if (pos >= 1_000) return `${(pos / 1_000).toFixed(1)}k`
  return String(pos)
}
