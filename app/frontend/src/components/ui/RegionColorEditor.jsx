/**
 * RegionColorEditor.jsx — Global region color editor.
 *
 * Right-click on selection → context menu → editor panel.
 * Right-click anywhere → "Reset all region colors" if overlays exist.
 *
 * Supports two types of region customization:
 * 1. Highlight color — transparent overlay on top of the track
 * 2. Bar/feature color — recolors the actual bars or gene features
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'
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
  const [editor, setEditor] = useState(null)

  const applicableTracks = tracks.filter(t =>
    t.visible !== false && t.track_type !== 'reads'
  )
  const hasOverlays = tracks.some(t => t.regionOverlays?.length > 0)

  // Listen for right-click events from SelectionOverlay and track area
  useEffect(() => {
    function onRegionContext(e) {
      setContextMenu({ x: e.detail.x, y: e.detail.y, hasSelection: true })
    }
    function onTrackContext(e) {
      // Only show if there are overlays to reset and no selection context already open
      if (hasOverlays) {
        setContextMenu({ x: e.detail.x, y: e.detail.y, hasSelection: false })
      }
    }
    window.addEventListener('bingo-region-context', onRegionContext)
    window.addEventListener('bingo-track-context', onTrackContext)
    return () => {
      window.removeEventListener('bingo-region-context', onRegionContext)
      window.removeEventListener('bingo-track-context', onTrackContext)
    }
  }, [hasOverlays])

  const openEditor = useCallback(() => {
    if (!selection) return
    setContextMenu(null)
    const selected = new Set(applicableTracks.map(t => t.id))
    setEditor({
      chrom: selection.chrom,
      start: selection.start,
      end: selection.end,
      highlightColor: '#42a5f5',
      highlightOpacity: 0.3,
      useHighlight: true,
      barColor: '#ff9800',
      useBarColor: false,
      selectedTracks: selected,
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
      highlightColor: editor.useHighlight ? editor.highlightColor : null,
      highlightOpacity: editor.highlightOpacity,
      barColor: editor.useBarColor ? editor.barColor : null,
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

  const t = theme

  return (
    <>
      {/* Context menu */}
      {contextMenu && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001 }}
          onClick={() => setContextMenu(null)}
          onContextMenu={e => { e.preventDefault(); setContextMenu(null) }}>
          <div style={{
            position: 'fixed',
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
            background: t.panelBg, border: `1px solid ${t.borderAccent}`,
            borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            padding: '4px 0', minWidth: 210, zIndex: 10002,
          }} onClick={e => e.stopPropagation()}>
            {selection && (
              <div style={{ padding: '5px 14px 7px', fontSize: 11, color: t.textTertiary,
                borderBottom: `1px solid ${t.border}` }}>
                {selection.chrom}:{selection.start.toLocaleString()}{'\u2013'}{selection.end.toLocaleString()}
              </div>
            )}
            {contextMenu.hasSelection && selection && (
              <div
                style={{ padding: '7px 14px', fontSize: 13, color: t.textPrimary, cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = t.selectedRow || 'rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={openEditor}
              >
                Edit region colors{'\u2026'}
              </div>
            )}
            {hasOverlays && (
              <div
                style={{ padding: '7px 14px', fontSize: 13, color: '#e57373', cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = t.selectedRow || 'rgba(255,255,255,0.06)'}
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
        <DraggablePanel title="Region Colors" onClose={() => setEditor(null)} theme={t}
          defaultWidth={360} defaultHeight={420}>
          <div style={{ padding: '14px 18px' }}>
            {/* Region info */}
            <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 14 }}>
              {editor.chrom}:{editor.start.toLocaleString()}{'\u2013'}{editor.end.toLocaleString()}
              <span style={{ color: t.textTertiary }}> ({(editor.end - editor.start).toLocaleString()} bp)</span>
            </div>

            {/* Highlight color */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.textPrimary, cursor: 'pointer', marginBottom: 6 }}>
                <input type="checkbox" checked={editor.useHighlight}
                  onChange={e => setEditor(p => ({ ...p, useHighlight: e.target.checked }))}
                  style={{ cursor: 'pointer', width: 14, height: 14 }} />
                Highlight color
              </label>
              {editor.useHighlight && (
                <div style={{ paddingLeft: 22 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input type="color" value={editor.highlightColor}
                      onChange={e => setEditor(p => ({ ...p, highlightColor: e.target.value }))}
                      style={{ width: 28, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                    <input type="text" value={editor.highlightColor}
                      onChange={e => {
                        let v = e.target.value.trim()
                        if (v && !v.startsWith('#')) v = '#' + v
                        if (/^#[0-9a-fA-F]{3,8}$/.test(v)) setEditor(p => ({ ...p, highlightColor: v }))
                      }}
                      style={{ background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 3,
                        color: t.textPrimary, padding: '3px 6px', fontSize: 12, fontFamily: 'monospace', width: 72 }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: t.textSecondary }}>Opacity</span>
                    <input type="range" min={0.1} max={0.8} step={0.05} value={editor.highlightOpacity}
                      onChange={e => setEditor(p => ({ ...p, highlightOpacity: parseFloat(e.target.value) }))}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <span style={{ fontSize: 12, color: t.textTertiary, width: 32 }}>{Math.round(editor.highlightOpacity * 100)}%</span>
                  </div>
                </div>
              )}
            </div>

            {/* Bar/feature recolor */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.textPrimary, cursor: 'pointer', marginBottom: 6 }}>
                <input type="checkbox" checked={editor.useBarColor}
                  onChange={e => setEditor(p => ({ ...p, useBarColor: e.target.checked }))}
                  style={{ cursor: 'pointer', width: 14, height: 14 }} />
                Recolor bars / features
              </label>
              {editor.useBarColor && (
                <div style={{ paddingLeft: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="color" value={editor.barColor}
                    onChange={e => setEditor(p => ({ ...p, barColor: e.target.value }))}
                    style={{ width: 28, height: 20, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                  <input type="text" value={editor.barColor}
                    onChange={e => {
                      let v = e.target.value.trim()
                      if (v && !v.startsWith('#')) v = '#' + v
                      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) setEditor(p => ({ ...p, barColor: v }))
                    }}
                    style={{ background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 3,
                      color: t.textPrimary, padding: '3px 6px', fontSize: 12, fontFamily: 'monospace', width: 72 }}
                  />
                </div>
              )}
            </div>

            {/* Preview */}
            <div style={{ display: 'flex', gap: 4, height: 16, borderRadius: 3, marginBottom: 14, overflow: 'hidden', border: `1px solid ${t.border}` }}>
              <div style={{ flex: 1, background: t.canvasBg, position: 'relative' }}>
                {editor.useBarColor && <div style={{ position: 'absolute', inset: 0, background: editor.barColor }} />}
                {editor.useHighlight && <div style={{ position: 'absolute', inset: 0, background: editor.highlightColor, opacity: editor.highlightOpacity }} />}
              </div>
            </div>

            {/* Track selection */}
            <div style={{ fontSize: 12, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Apply to tracks
            </div>
            <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 14, border: `1px solid ${t.border}`, borderRadius: 4 }}>
              {applicableTracks.length === 0 ? (
                <div style={{ fontSize: 12, color: t.textTertiary, padding: 8 }}>No applicable tracks</div>
              ) : applicableTracks.map(tr => {
                const isChecked = editor.selectedTracks.has(tr.id)
                return (
                  <label key={tr.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', cursor: 'pointer',
                    background: isChecked ? (t.selectedRow || 'rgba(255,255,255,0.04)') : 'transparent',
                  }}>
                    <input type="checkbox" checked={isChecked}
                      onChange={() => toggleTrack(tr.id)}
                      style={{ cursor: 'pointer', width: 14, height: 14, flexShrink: 0 }} />
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: tr.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: t.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tr.name}
                    </span>
                    <span style={{ fontSize: 10, color: t.textTertiary, flexShrink: 0 }}>{tr.track_type}</span>
                  </label>
                )
              })}
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ background: t.btnBg, border: `1px solid ${t.borderStrong}`, borderRadius: 4,
                color: t.btnText, padding: '6px 16px', cursor: 'pointer', fontSize: 12 }}
                onClick={() => setEditor(null)}>Cancel</button>
              <button style={{ background: '#1976d2', border: 'none', borderRadius: 4,
                color: '#fff', padding: '6px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                opacity: editor.selectedTracks.size > 0 && (editor.useHighlight || editor.useBarColor) ? 1 : 0.4 }}
                disabled={editor.selectedTracks.size === 0 || (!editor.useHighlight && !editor.useBarColor)}
                onClick={applyOverlay}>
                Apply to {editor.selectedTracks.size} track{editor.selectedTracks.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </DraggablePanel>
      )}
    </>
  )
}
