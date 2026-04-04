/**
 * CoverageTrack.jsx — Canvas renderer for signal/coverage data (BigWig, WIG, BedGraph).
 *
 * Draws vertical bars with optional forward/reverse strand split.
 * Supports auto or fixed bar width, log scale, and custom Y-axis range.
 */
import React, { useRef, useEffect } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData } from '../../hooks/useTrackData'

const log2 = Math.log2

function logScale(val, max) {
  // Maps val ∈ [0, max] → [0, 1] on a log₂ scale
  if (val <= 0 || max <= 0) return 0
  return Math.log2(val + 1) / Math.log2(max + 1)
}

export default function CoverageTrack({ track, width, height, onWarning }) {
  const canvasRef = useRef(null)
  const { region } = useBrowser()
  const { theme } = useTheme()
  const { data, loading, error } = useTrackData(track, region, width)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = theme.canvasBg
    ctx.fillRect(0, 0, width, height)

    if (loading && !data?.bins?.length) {
      ctx.fillStyle = theme.textTertiary; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (error) {
      ctx.fillStyle = '#ef9a9a'; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText(typeof error === 'string' ? error : JSON.stringify(error), 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (!data?.bins?.length) {
      if (onWarning) onWarning(null)
      return
    }

    const maxVal = data.max_value || 0
    const minVal = data.min_value || 0
    const hasNegative = minVal < 0
    const regionStart = region.start
    const regionLen = region.end - region.start
    const color = track.color || '#78909c'
    const userScaleMax = track.scaleMax != null ? track.scaleMax : null
    const userScaleMin = track.scaleMin != null ? track.scaleMin : null
    const useLog = track.logScale === true
    const barAuto = track.barAutoWidth !== false
    const barFixedPx = track.barWidth || 2
    const fwdColor = color
    const revColor = adjustColor(color, -40)

    // Pixels per single nucleotide — auto bars are capped to this width
    const pxPerNt = width / regionLen

    if (hasNegative) {
      const margin = 12
      const midY = Math.round(height / 2)
      const topH = midY - margin / 2
      const botH = height - midY - margin / 2
      const posMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
      const negMax = userScaleMin != null ? userScaleMin : (Math.abs(minVal) || 1)

      ctx.strokeStyle = theme.centerLine; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(width, midY); ctx.stroke()

      for (const bin of data.bins) {
        const binW = ((bin.end - bin.start) / regionLen) * width
        const autoW = Math.max(1, Math.min(pxPerNt, binW))
        const w = barAuto ? autoW : Math.min(barFixedPx, binW)
        const x = ((bin.start - regionStart) / regionLen) * width
        const fwd = bin.forward != null ? bin.forward : Math.max(0, bin.value)
        const rev = bin.reverse != null ? bin.reverse : Math.min(0, bin.value)
        if (fwd > 0) {
          const ratio = useLog ? logScale(fwd, posMax) : fwd / posMax
          ctx.fillStyle = fwdColor; ctx.fillRect(x, midY - ratio * topH, w, ratio * topH)
        }
        if (rev < 0) {
          const ratio = useLog ? logScale(Math.abs(rev), negMax) : Math.abs(rev) / negMax
          ctx.fillStyle = revColor; ctx.fillRect(x, midY, w, ratio * botH)
        }
      }

      ctx.fillStyle = theme.textSecondary; ctx.font = '10px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'
      const scaleLabel = useLog ? ' log\u2082' : ''
      ctx.fillText(`+${posMax.toFixed(1)}${scaleLabel}`, 2, margin)
      ctx.fillText(`\u2212${negMax.toFixed(1)}${scaleLabel}`, 2, height - 2)
      ctx.fillStyle = theme.textTertiary; ctx.fillText('0', 2, midY - 2)
    } else {
      const effectiveMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
      ctx.fillStyle = fwdColor
      for (const bin of data.bins) {
        const binW = ((bin.end - bin.start) / regionLen) * width
        const autoW = Math.max(1, Math.min(pxPerNt, binW))
        const w = barAuto ? autoW : Math.min(barFixedPx, binW)
        const x = ((bin.start - regionStart) / regionLen) * width
        const ratio = useLog ? logScale(bin.value, effectiveMax) : bin.value / effectiveMax
        const barH = ratio * (height - 14)
        ctx.fillRect(x, height - barH - 2, w, barH)
      }
      ctx.fillStyle = theme.textSecondary; ctx.font = '10px Arial, Helvetica, sans-serif'; ctx.textAlign = 'left'
      const scaleLabel = useLog ? ' log\u2082' : ''
      ctx.fillText(`${effectiveMax.toFixed(1)}${scaleLabel}`, 2, 10)
    }

    // Detect clipping warnings
    if (onWarning) {
      const warnings = []
      if (userScaleMax != null && maxVal > userScaleMax) {
        warnings.push(`Bars clipped: max value ${maxVal.toFixed(1)} exceeds scale ${userScaleMax.toFixed(1)}`)
      }
      if (hasNegative && userScaleMin != null && Math.abs(minVal) > userScaleMin) {
        warnings.push(`Negative bars clipped: min value ${Math.abs(minVal).toFixed(1)} exceeds scale ${userScaleMin.toFixed(1)}`)
      }
      onWarning(warnings.length > 0 ? warnings.join('\n') : null)
    }
  }, [data, loading, error, width, height, region, track.color, track.scaleMax, track.scaleMin, track.logScale, track.barAutoWidth, track.barWidth, theme])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height }} />
}

function adjustColor(hex, delta) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  const clamp = v => Math.max(0, Math.min(255, v + delta))
  return `rgb(${clamp(parseInt(m[1], 16))},${clamp(parseInt(m[2], 16))},${clamp(parseInt(m[3], 16))})`
}
