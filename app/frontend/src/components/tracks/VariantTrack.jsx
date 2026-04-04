/**
 * VariantTrack.jsx — Canvas renderer for variant calls (VCF).
 *
 * Draws vertical lollipop markers for each variant with quality-based
 * coloring (green/yellow/red). Dots indicate variant positions.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData } from '../../hooks/useTrackData'

export default function VariantTrack({ track, width, height, onWarning }) {
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

    if (loading && !data?.variants?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (!data?.variants?.length) {
      if (data) { ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'; ctx.fillText('No variants in region', 8, height / 2 + 4) }
      if (onWarning) onWarning(null)
      return
    }

    const regionLen = region.end - region.start
    const barAuto = track.barAutoWidth !== false
    const barFixedPx = track.barWidth || 2
    const lineW = barAuto ? 1 : Math.max(0.5, barFixedPx)
    const dotR = barAuto ? 5 : Math.max(2, barFixedPx * 2)
    for (const v of data.variants) {
      const x = ((v.pos - region.start) / regionLen) * width
      const color = variantColor(v.ref, v.alt)
      ctx.strokeStyle = color; ctx.lineWidth = lineW
      ctx.beginPath(); ctx.moveTo(x, height - 4); ctx.lineTo(x, 14); ctx.stroke()
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, 10, dotR, 0, Math.PI * 2); ctx.fill()
      if (regionLen < 5000) {
        ctx.fillStyle = theme.textPrimary; ctx.font = '9px Arial, Helvetica, sans-serif'; ctx.textAlign = 'center'
        ctx.fillText(`${v.ref}>${v.alt[0] || '?'}`, x, height - 6)
      }
    }
    if (onWarning) {
      // Warn when too many variants overlap (>50 in view makes dots overlap significantly)
      const visibleCount = data.variants.filter(v => v.pos >= region.start && v.pos <= region.end).length
      onWarning(visibleCount > 50
        ? `${visibleCount} variants overlapping \u2014 zoom in for detail`
        : null)
    }
  }, [data, loading, width, height, region, track.color, track.barAutoWidth, track.barWidth, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
}

function variantColor(ref, alts) {
  const alt = alts[0] || ''
  if (ref.length === 1 && alt.length === 1) return '#ffb74d'
  if (alt.length > ref.length) return '#81c784'
  if (alt.length < ref.length) return '#e57373'
  return '#b0bec5'
}
