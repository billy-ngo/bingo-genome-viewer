/**
 * RegionColorEditor.jsx — Global right-click context menu and color editor
 * for applying region color overlays across multiple tracks.
 *
 * Rendered once in App.jsx. Triggered by right-click on any selection highlight.
 * Lists all applicable tracks (not BAM reads) with checkboxes.
 */
import React, { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import DraggablePanel from './DraggablePanel'

export default function RegionColorEditor() {
  const { selection } = useBrowser()
  const { tracks, updateTrack } = useTracks()
  const { theme } = useTheme()
  const [contextMenu, setContextMenu] = useState(null)
  const [editor, setEditor] = useState(null) // { start, end, chrom, color, opacity, selectedTracks: Set }

  // Applicable tracks (not BAM reads)
  const applicableTracks = tracks.filter(t =>
    t.visible !== false && t.track_type !== 'reads'
  )
  const hasOverlays = tracks.some(t => t.regionOverlays?.length > 0)

  // Listen for custom event from SelectionOverlay
  useEffect(() => {
    function onRegionContext(e) {
      setContextMenu({ x: e.detail.x, y: e.detail.y })
    }
    window.addEventListener('bingo-region-context', onRegionContext)
    return () => window.removeEventListener('bingo-region-context', onRegionContext)
  }, [])

  const openEditor = useCallback(() => {
    if (!selection) return
    setContextMenu(null)
    setEditor({
      chrom: selection.chrom,
      start: selection.start,
      end: selection.end,
      color: '#42a5f5',
      opacity: 0.35,
      selectedTracks: new Set(applicableTracks.map(t => t.id)),
    })
  }, [selection, applicableTracks])

  const resetAll = useCallback(() => {
    setContextMenu(null)
    for (const t of tracks) {
      if (t.regionOverlays?.length > 0) {
        updateTrack(t.id, { regionOverlays: [] })
      }
    }
  }, [tracks, updateTrack])

  const applyOverlay = useCallback(() => {
    if (!editor) return
    const newOverlay = {
      chrom: editor.chrom,
      start: editor.start,
      end: editor.end,
      color: editor.color,
      opacity: editor.opacity,
    }
    for (const tid of editor.selectedTracks) {
      const track = tracks.find(t => t.id === tid)
      if (!track) continue
      const existing = (track.regionOverlays || []).filter(o =>
        !(o.chrom === newOverlay.chrom && o.start === newOverlay.start && o.end === newOverlay.end)
      )
      updateTrack(tid, { regionOverlays: [...existing, newOverlay] })
    }
    setEditor(null)
  }, [editor, tracks, updateTrack])

  const toggleTrack = useCallback((tid) => {
    setEditor(prev => {
      if (!prev) return prev
      const next = new Set(prev.selectedTracks)
      if (next.has(tid)) next.delete(tid); else next.add(tid)
      return { ...prev, selectedTracks: next }
    })
  }, [])

  if (!selection) return null

  return (
    <>
      {/* Context menu */}
      {contextMenu && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001 }} onClick={() => setContextMenu(null)}>
          <div style={{
            position: 'fixed', left: contextMenu.x, top: contextMenu.y,
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
            borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            padding: '4px 0', minWidth: 200, zIndex: 10002,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '4px 14px 6px', fontSize: 10, color: theme.textTertiary, borderBottom: `1px solid ${theme.border}` }}>
              {selection.chrom}:{selection.start.toLocaleString()}-{selection.end.toLocaleString()}
            </div>
            <div
              style={{ padding: '6px 14px', fontSize: 12, color: theme.textPrimary, cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={openEditor}
            >
              Edit region colors...
            </div>
            {hasOverlays && (
              <div
                style={{ padding: '6px 14px', fontSize: 12, color: '#e57373', cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={resetAll}
              >
                Reset all region colors
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Editor panel */}
      {editor && (
        <DraggablePanel title="Region Colors" onClose={() => setEditor(null)} theme={theme} defaultWidth={340} defaultHeight={360}>
          <div style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 10 }}>
              {editor.chrom}:{editor.start.toLocaleString()}-{editor.end.toLocaleString()}
              {' '}({(editor.end - editor.start).toLocaleString()} bp)
            </div>

            {/* Color + opacity */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: theme.textSecondary, width: 50 }}>Color</span>
              <input type="color" value={editor.color}
                onChange={e => setEditor(p => ({ ...p, color: e.target.value }))}
                style={{ width: 28, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <input type="text" value={editor.color}
                onChange={e => {
                  let v = e.target.value.trim()
                  if (v && !v.startsWith('#')) v = '#' + v
                  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) setEditor(p => ({ ...p, color: v }))
                }}
                style={{ background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
                  color: theme.textPrimary, padding: '2px 5px', fontSize: 10, fontFamily: 'monospace', width: 65 }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: theme.textSecondary, width: 50 }}>Opacity</span>
              <input type="range" min={0.1} max={0.8} step={0.05} value={editor.opacity}
                onChange={e => setEditor(p => ({ ...p, opacity: parseFloat(e.target.value) }))}
                style={{ flex: 1, cursor: 'pointer', accentColor: theme.textSecondary }} />
              <span style={{ fontSize: 10, color: theme.textTertiary, width: 28 }}>{Math.round(editor.opacity * 100)}%</span>
            </div>

            {/* Preview */}
            <div style={{ height: 20, borderRadius: 4, marginBottom: 12,
              background: editor.color, opacity: editor.opacity,
              border: `1px solid ${theme.border}` }} />

            {/* Track selection */}
            <div style={{ fontSize: 11, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
              Apply to tracks
            </div>
            <div style={{ maxHeight: 140, overflowY: 'auto', marginBottom: 12 }}>
              {applicableTracks.length === 0 ? (
                <div style={{ fontSize: 11, color: theme.textTertiary, padding: 4 }}>No applicable tracks</div>
              ) : applicableTracks.map(t => (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', cursor: 'pointer',
                  borderRadius: 3,
                }} onClick={() => toggleTrack(t.id)}
                  onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <input type="checkbox" checked={editor.selectedTracks.has(t.id)}
                    onChange={() => toggleTrack(t.id)}
                    style={{ cursor: 'pointer', width: 13, height: 13 }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                  </span>
                  <span style={{ fontSize: 9, color: theme.textTertiary, flexShrink: 0 }}>{t.track_type}</span>
                </div>
              ))}
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                color: theme.btnText, padding: '5px 14px', cursor: 'pointer', fontSize: 11 }}
                onClick={() => setEditor(null)}>Cancel</button>
              <button style={{ background: '#1976d2', border: 'none', borderRadius: 4,
                color: '#fff', padding: '5px 14px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                opacity: editor.selectedTracks.size > 0 ? 1 : 0.4 }}
                disabled={editor.selectedTracks.size === 0}
                onClick={applyOverlay}>Apply to {editor.selectedTracks.size} track{editor.selectedTracks.size !== 1 ? 's' : ''}</button>
            </div>
          </div>
        </DraggablePanel>
      )}
    </>
  )
}
