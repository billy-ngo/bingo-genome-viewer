/**
 * SelectionOverlay.jsx — Renders selection highlight, region color overlays,
 * and a right-click context menu for editing region colors.
 *
 * Region overlays are colored rectangles that persist on top of the track
 * canvas until reset. They don't modify the underlying rendering.
 */
import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

export default function SelectionOverlay({ width, height, trackData, trackType, trackId }) {
  const { region, selection, clearSelection, setSelection } = useBrowser()
  const { updateTrack, tracks } = useTracks()
  const { theme } = useTheme()
  const [hover, setHover] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [contextMenu, setContextMenu] = useState(null) // { x, y }
  const [colorEditor, setColorEditor] = useState(null) // { start, end, color, opacity }

  const track = tracks.find(t => t.id === trackId)
  const overlays = track?.regionOverlays || []
  const isReadTrack = trackType === 'reads'

  const onMouseMove = useCallback((e) => {
    setMousePos({ x: e.clientX, y: e.clientY })
    setHover(true)
  }, [])

  const onMouseLeave = useCallback(() => setHover(false), [])

  const onContextMenu = useCallback((e) => {
    if (isReadTrack) return // disabled for BAM tracks
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isReadTrack])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const openColorEditor = useCallback(() => {
    if (!selection) return
    setContextMenu(null)
    setColorEditor({
      start: selection.start,
      end: selection.end,
      chrom: selection.chrom,
      color: track?.color || '#42a5f5',
      opacity: 0.35,
    })
  }, [selection, track])

  const applyOverlay = useCallback(() => {
    if (!colorEditor || !trackId) return
    const newOverlay = {
      chrom: colorEditor.chrom,
      start: colorEditor.start,
      end: colorEditor.end,
      color: colorEditor.color,
      opacity: colorEditor.opacity,
    }
    const existing = overlays.filter(o =>
      !(o.chrom === newOverlay.chrom && o.start === newOverlay.start && o.end === newOverlay.end)
    )
    updateTrack(trackId, { regionOverlays: [...existing, newOverlay] })
    setColorEditor(null)
  }, [colorEditor, trackId, overlays, updateTrack])

  const resetOverlays = useCallback(() => {
    setContextMenu(null)
    if (trackId) updateTrack(trackId, { regionOverlays: [] })
  }, [trackId, updateTrack])

  if (!region) return null

  const regionLen = region.end - region.start
  if (regionLen <= 0) return null

  // Map genomic position to pixel
  const toX = (pos) => ((pos - region.start) / regionLen) * width

  // Compute selection highlight pixels
  let selPxLeft = 0, selPxWidth = 0, hasSelection = false
  if (selection && selection.chrom === region.chrom) {
    selPxLeft = Math.max(0, toX(selection.start))
    const selPxRight = Math.min(width, toX(selection.end))
    selPxWidth = selPxRight - selPxLeft
    hasSelection = selPxWidth >= 1
  }

  // Compute stats for tooltip
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
        return (
          <div key={i} style={{
            position: 'absolute', left: ox, top: 0, width: ow, height: '100%',
            background: o.color, opacity: o.opacity || 0.35,
            pointerEvents: 'none',
          }} />
        )
      })}

      {/* Selection highlight */}
      {hasSelection && (
        <div
          style={{
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

      {/* Context menu */}
      {contextMenu && !isReadTrack && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001 }} onClick={closeContextMenu}>
          <div style={{
            position: 'fixed', left: contextMenu.x, top: contextMenu.y,
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
            borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            padding: '4px 0', minWidth: 180, zIndex: 10002,
          }} onClick={e => e.stopPropagation()}>
            <div
              style={{ padding: '6px 14px', fontSize: 12, color: theme.textPrimary, cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={openColorEditor}
            >
              Edit region colors
            </div>
            {overlays.length > 0 && (
              <div
                style={{ padding: '6px 14px', fontSize: 12, color: '#e57373', cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={resetOverlays}
              >
                Reset to track defaults
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Region color editor */}
      {colorEditor && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001 }} onClick={() => setColorEditor(null)}>
          <div style={{
            position: 'fixed', left: Math.min(mousePos.x + 10, window.innerWidth - 240),
            top: Math.min(mousePos.y + 10, window.innerHeight - 200),
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
            borderRadius: 8, padding: '14px 18px', minWidth: 200,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 10002,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.textPrimary, marginBottom: 10 }}>
              Region Color
            </div>
            <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 10 }}>
              {colorEditor.chrom}:{colorEditor.start.toLocaleString()}-{colorEditor.end.toLocaleString()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: theme.textSecondary }}>Color</span>
              <input type="color" value={colorEditor.color}
                onChange={e => setColorEditor(prev => ({ ...prev, color: e.target.value }))}
                style={{ width: 28, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <input type="text" value={colorEditor.color}
                onChange={e => {
                  let v = e.target.value.trim()
                  if (v && !v.startsWith('#')) v = '#' + v
                  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) setColorEditor(prev => ({ ...prev, color: v }))
                }}
                style={{ background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
                  color: theme.textPrimary, padding: '2px 5px', fontSize: 10, fontFamily: 'monospace', width: 65 }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: theme.textSecondary }}>Opacity</span>
              <input type="range" min={0.1} max={0.8} step={0.05} value={colorEditor.opacity}
                onChange={e => setColorEditor(prev => ({ ...prev, opacity: parseFloat(e.target.value) }))}
                style={{ flex: 1, cursor: 'pointer', accentColor: theme.textSecondary }} />
              <span style={{ fontSize: 10, color: theme.textTertiary, width: 28 }}>{Math.round(colorEditor.opacity * 100)}%</span>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                color: theme.btnText, padding: '4px 12px', cursor: 'pointer', fontSize: 11 }}
                onClick={() => setColorEditor(null)}>Cancel</button>
              <button style={{ background: '#1976d2', border: 'none', borderRadius: 4,
                color: '#fff', padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                onClick={applyOverlay}>Apply</button>
            </div>
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
    let insertions = 0
    for (const r of reads) {
      if (r.cigar) { const matches = r.cigar.match(/(\d+)I/g); if (matches) for (const m of matches) insertions += parseInt(m) }
    }
    if (insertions > 0) stats.push({ label: 'Insertion bases', value: insertions.toLocaleString() })
    if (reads.length > 0) stats.push({ label: 'Avg MAPQ', value: (reads.reduce((s, r) => s + (r.mapq || 0), 0) / reads.length).toFixed(1) })
  }

  if ((trackType === 'coverage' || trackType === 'reads') && trackData.bins) {
    const bins = trackData.bins.filter(b => b.end > selection.start && b.start < selection.end)
    if (bins.length > 0) {
      const values = bins.map(b => b.value)
      const avg = values.reduce((s, v) => s + v, 0) / values.length
      stats.push({ label: 'Avg coverage', value: avg.toFixed(1) })
      stats.push({ label: 'Max coverage', value: Math.max(...values).toFixed(1) })
    }
  }

  if (trackType === 'variants' && trackData.variants) {
    stats.push({ label: 'Variants in region', value: trackData.variants.filter(v => v.pos >= selection.start && v.pos < selection.end).length.toLocaleString() })
  }

  if ((trackType === 'annotations' || trackType === 'genome_annotations') && trackData.features) {
    stats.push({ label: 'Features in region', value: trackData.features.filter(f => f.end > selection.start && f.start < selection.end).length.toLocaleString() })
  }

  return stats
}
