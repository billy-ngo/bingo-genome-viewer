/**
 * SelectionOverlay.jsx — Renders selection highlight and persistent region
 * color overlays on each track. Right-click dispatches a custom event
 * for the global RegionColorEditor to handle.
 */
import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

export default function SelectionOverlay({ width, height, trackData, trackType, trackId }) {
  const { region, selection, clearSelection } = useBrowser()
  const { tracks } = useTracks()
  const { theme } = useTheme()
  const [hover, setHover] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })

  const track = tracks.find(t => t.id === trackId)
  const overlays = track?.regionOverlays || []
  const isReadTrack = trackType === 'reads'

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

  if (!region) return null
  const regionLen = region.end - region.start
  if (regionLen <= 0) return null

  const toX = (pos) => ((pos - region.start) / regionLen) * width

  let selPxLeft = 0, selPxWidth = 0, hasSelection = false
  if (selection && selection.chrom === region.chrom) {
    selPxLeft = Math.max(0, toX(selection.start))
    selPxWidth = Math.min(width, toX(selection.end)) - selPxLeft
    hasSelection = selPxWidth >= 1
  }

  const stats = hasSelection ? computeStats(selection, trackData, trackType) : []
  const selLen = selection ? selection.end - selection.start : 0
  const tipWidth = 260
  const tipX = Math.min(mousePos.x + 14, window.innerWidth - tipWidth - 10)
  const tipY = Math.min(mousePos.y + 14, window.innerHeight - 200)

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none' }}>
      {/* Persistent region color overlays */}
      {overlays.map((o, i) => {
        if (o.chrom !== region.chrom) return null
        const ox = Math.max(0, toX(o.start))
        const ow = Math.min(width, toX(o.end)) - ox
        if (ow < 1) return null
        return <div key={i} style={{
          position: 'absolute', left: ox, top: 0, width: ow, height: '100%',
          background: o.color, opacity: o.opacity || 0.35, pointerEvents: 'none',
        }} />
      })}

      {/* Selection highlight */}
      {hasSelection && (
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

      {/* Tooltip */}
      {hover && hasSelection && createPortal(
        <div style={{
          position: 'fixed', left: tipX, top: tipY,
          background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
          borderRadius: 6, padding: '8px 12px', fontSize: 11,
          color: theme.textPrimary, lineHeight: 1.6,
          pointerEvents: 'none', zIndex: 10000,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          minWidth: 180, maxWidth: tipWidth,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Selected Region</div>
          <div><span style={{ color: theme.textSecondary }}>Region:</span> {selection.chrom}:{selection.start.toLocaleString()}-{selection.end.toLocaleString()}</div>
          <div><span style={{ color: theme.textSecondary }}>Length:</span> {selLen.toLocaleString()} bp</div>
          {stats.map((s, i) => (
            <div key={i}><span style={{ color: theme.textSecondary }}>{s.label}:</span> {s.value}</div>
          ))}
          <div style={{ fontSize: 9, color: theme.textTertiary, marginTop: 4 }}>
            Click to dismiss{!isReadTrack ? ' · Right-click for region colors' : ''}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function computeStats(selection, trackData, trackType) {
  const stats = []
  if (!trackData) return stats
  if (trackType === 'reads' && trackData.reads) {
    const reads = trackData.reads.filter(r => r.end > selection.start && r.start < selection.end)
    stats.push({ label: 'Reads in region', value: reads.length.toLocaleString() })
    let ins = 0
    for (const r of reads) { if (r.cigar) { const m = r.cigar.match(/(\d+)I/g); if (m) for (const x of m) ins += parseInt(x) } }
    if (ins > 0) stats.push({ label: 'Insertion bases', value: ins.toLocaleString() })
    if (reads.length > 0) stats.push({ label: 'Avg MAPQ', value: (reads.reduce((s, r) => s + (r.mapq || 0), 0) / reads.length).toFixed(1) })
  }
  if ((trackType === 'coverage' || trackType === 'reads') && trackData.bins) {
    const bins = trackData.bins.filter(b => b.end > selection.start && b.start < selection.end)
    if (bins.length > 0) { const v = bins.map(b => b.value); stats.push({ label: 'Avg coverage', value: (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) }); stats.push({ label: 'Max coverage', value: Math.max(...v).toFixed(1) }) }
  }
  if (trackType === 'variants' && trackData.variants) stats.push({ label: 'Variants', value: trackData.variants.filter(v => v.pos >= selection.start && v.pos < selection.end).length.toLocaleString() })
  if ((trackType === 'annotations' || trackType === 'genome_annotations') && trackData.features) stats.push({ label: 'Features', value: trackData.features.filter(f => f.end > selection.start && f.start < selection.end).length.toLocaleString() })
  return stats
}
