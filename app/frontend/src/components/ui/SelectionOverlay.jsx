/**
 * SelectionOverlay.jsx — Renders selection highlight and persistent region
 * color overlays on each track. Optimized to avoid unnecessary re-renders.
 */
import React, { useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'

export default function SelectionOverlay({ width, height, trackData, trackType, trackId, regionOverlays }) {
  const { region, selection, clearSelection } = useBrowser()
  const { theme } = useTheme()
  const [hover, setHover] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })

  const isReadTrack = trackType === 'reads'
  const hasOverlays = regionOverlays && regionOverlays.length > 0
  const hasSelection = Boolean(selection && region && selection.chrom === region.chrom)

  const onMouseMove = useCallback((e) => {
    setMousePos({ x: e.clientX, y: e.clientY })
    setHover(true)
  }, [])
  const onMouseLeave = useCallback(() => setHover(false), [])

  const onContextMenu = useCallback((e) => {
    if (isReadTrack) return
    e.preventDefault()
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('bingo-region-context', { detail: { x: e.clientX, y: e.clientY } }))
  }, [isReadTrack])

  // Early exit — nothing to render
  if (!region || !hasSelection && !hasOverlays) return null

  const regionLen = region.end - region.start
  if (regionLen <= 0) return null
  const toX = (pos) => ((pos - region.start) / regionLen) * width

  // Selection highlight pixels
  let selPxLeft = 0, selPxWidth = 0
  if (hasSelection) {
    selPxLeft = Math.max(0, toX(selection.start))
    selPxWidth = Math.min(width, toX(selection.end)) - selPxLeft
    if (selPxWidth < 1) selPxWidth = 0
  }

  // Only compute stats when actually hovering
  const stats = hover && selPxWidth > 0 ? computeStats(selection, trackData, trackType) : []
  const selLen = selection ? selection.end - selection.start : 0
  const tipWidth = 260
  const tipX = Math.min(mousePos.x + 14, window.innerWidth - tipWidth - 10)
  const tipY = Math.min(mousePos.y + 14, window.innerHeight - 200)

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none' }}>
      {/* Persistent region highlight overlays */}
      {hasOverlays && regionOverlays.map((o, i) => {
        if (!o.highlightColor || o.chrom !== region.chrom) return null
        const ox = Math.max(0, toX(o.start))
        const ow = Math.min(width, toX(o.end)) - ox
        if (ow < 1) return null
        return <div key={i} style={{
          position: 'absolute', left: ox, top: 0, width: ow, height: '100%',
          background: o.highlightColor, opacity: o.highlightOpacity || 0.35, pointerEvents: 'none',
        }} />
      })}

      {/* Selection highlight */}
      {selPxWidth > 0 && (
        <div style={{
          position: 'absolute', left: selPxLeft, top: 0, width: selPxWidth, height: '100%',
          background: 'rgba(100, 181, 246, 0.2)',
          borderLeft: '1px solid rgba(100, 181, 246, 0.6)',
          borderRight: '1px solid rgba(100, 181, 246, 0.6)',
          pointerEvents: 'auto', cursor: 'crosshair',
        }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          onClick={(e) => { e.stopPropagation(); clearSelection() }}
          onContextMenu={onContextMenu}
        />
      )}

      {/* Tooltip — only when hovering */}
      {hover && selPxWidth > 0 && createPortal(
        <div style={{
          position: 'fixed', left: tipX, top: tipY,
          background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
          borderRadius: 6, padding: '8px 12px', fontSize: 11,
          color: theme.textPrimary, lineHeight: 1.6,
          pointerEvents: 'none', zIndex: 10000,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', minWidth: 180, maxWidth: tipWidth,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Selected Region</div>
          <div><span style={{ color: theme.textSecondary }}>Region:</span> {selection.chrom}:{selection.start.toLocaleString()}-{selection.end.toLocaleString()}</div>
          <div><span style={{ color: theme.textSecondary }}>Length:</span> {selLen.toLocaleString()} bp</div>
          {stats.map((s, i) => (
            <div key={i}><span style={{ color: theme.textSecondary }}>{s.label}:</span> {s.value}</div>
          ))}
          <div style={{ fontSize: 9, color: theme.textTertiary, marginTop: 4 }}>
            Click to dismiss{!isReadTrack ? ' \u00b7 Right-click for region colors' : ''}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function computeStats(selection, trackData, trackType) {
  const stats = []
  if (!trackData || !selection) return stats
  if (trackType === 'reads' && trackData.reads) {
    const reads = trackData.reads.filter(r => r.end > selection.start && r.start < selection.end)
    stats.push({ label: 'Reads', value: reads.length.toLocaleString() })
  }
  if ((trackType === 'coverage' || trackType === 'reads') && trackData.bins) {
    const bins = trackData.bins.filter(b => b.end > selection.start && b.start < selection.end)
    if (bins.length > 0) { const v = bins.map(b => b.value); stats.push({ label: 'Avg cov', value: (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) }) }
  }
  if (trackType === 'variants' && trackData.variants) stats.push({ label: 'Variants', value: trackData.variants.filter(v => v.pos >= selection.start && v.pos < selection.end).length.toLocaleString() })
  if ((trackType === 'annotations' || trackType === 'genome_annotations') && trackData.features) stats.push({ label: 'Features', value: trackData.features.filter(f => f.end > selection.start && f.start < selection.end).length.toLocaleString() })
  return stats
}
