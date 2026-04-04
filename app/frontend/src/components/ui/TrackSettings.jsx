/**
 * TrackSettings.jsx — Bulk track configuration panel.
 *
 * Allows adjusting visibility, height, color, scale (linear/log),
 * Y-axis range, and bar width for selected tracks.
 */
import React, { useState } from 'react'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

export default function TrackSettings({ onClose }) {
  const { theme } = useTheme()
  const { tracks, updateTrack, updateMultipleTracks, removeTrack } = useTracks()
  const [selected, setSelected] = useState(new Set())

  function toggle(id) {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function selectAll() { setSelected(new Set(tracks.map(t => t.id))) }
  function selectNone() { setSelected(new Set()) }

  const selectedTracks = tracks.filter(t => selected.has(t.id))
  const hasAnnotation = selectedTracks.some(t => t.track_type === 'annotations' || t.track_type === 'genome_annotations')
  const hasCoverage = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads')
  const hasBars = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads' || t.track_type === 'variants')

  const commonHeight = selectedTracks.length > 0 && selectedTracks.every(t => t.height === selectedTracks[0].height) ? selectedTracks[0].height : ''
  const commonColor = selectedTracks.length > 0 && selectedTracks.every(t => t.color === selectedTracks[0].color) ? selectedTracks[0].color : '#888888'
  const commonVisible = selectedTracks.length > 0 && selectedTracks.every(t => t.visible === selectedTracks[0].visible) ? selectedTracks[0].visible : null
  const commonArrows = selectedTracks.length > 0 && selectedTracks.every(t => t.useArrows === selectedTracks[0].useArrows) ? selectedTracks[0].useArrows : null
  const commonScaleMax = selectedTracks.length > 0 && selectedTracks.every(t => t.scaleMax === selectedTracks[0].scaleMax) ? selectedTracks[0].scaleMax : undefined
  const commonScaleMin = selectedTracks.length > 0 && selectedTracks.every(t => t.scaleMin === selectedTracks[0].scaleMin) ? selectedTracks[0].scaleMin : undefined
  const isAutoScale = (commonScaleMax === null || commonScaleMax === undefined) && (commonScaleMin === null || commonScaleMin === undefined)
  const commonLogScale = selectedTracks.length > 0 && selectedTracks.every(t => t.logScale === selectedTracks[0].logScale) ? selectedTracks[0].logScale : null
  const commonBarAutoWidth = selectedTracks.length > 0 && selectedTracks.every(t => t.barAutoWidth === selectedTracks[0].barAutoWidth) ? selectedTracks[0].barAutoWidth : null
  const commonBarWidth = selectedTracks.length > 0 && selectedTracks.every(t => t.barWidth === selectedTracks[0].barWidth) ? selectedTracks[0].barWidth : undefined

  function applyToSelected(updates) { updateMultipleTracks([...selected], updates) }
  function removeSelected() { for (const id of selected) removeTrack(id); setSelected(new Set()) }

  const t = theme
  const S = {
    overlay: { position: 'fixed', inset: 0, background: t.overlayBg, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    panel: { background: t.panelBg, border: `1px solid ${t.borderAccent}`, borderRadius: 8, padding: 0, minWidth: 420, maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${t.border}` },
    title: { fontSize: 14, fontWeight: 700, color: t.textPrimary },
    closeBtn: { background: 'none', border: 'none', color: t.textSecondary, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' },
    body: { padding: '8px 0', overflowY: 'auto', flex: 1 },
    trackRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 16px', cursor: 'pointer', transition: 'background 0.1s' },
    trackRowSelected: { background: t.selectedRow },
    checkbox: { width: 14, height: 14, cursor: 'pointer', flexShrink: 0 },
    trackLabel: { fontSize: 12, color: t.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    trackType: { fontSize: 10, color: t.textTertiary, flexShrink: 0 },
    section: { padding: '12px 16px', borderTop: `1px solid ${t.border}` },
    sectionTitle: { fontSize: 11, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
    controlRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
    controlLabel: { fontSize: 12, color: t.textSecondary, width: 90 },
    input: { background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '3px 6px', fontSize: 12, width: 70 },
    colorInput: { width: 28, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 },
    btn: { background: t.btnBg, border: 'none', borderRadius: 4, color: t.btnText, padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    btnDanger: { background: t.btnDanger, border: 'none', borderRadius: 4, color: '#fff', padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: `1px solid ${t.border}`, gap: 8 },
    smallBtn: { background: 'none', border: `1px solid ${t.borderAccent}`, borderRadius: 3, color: t.textSecondary, cursor: 'pointer', fontSize: 10, padding: '2px 8px' },
    cbLabel: { fontSize: 12, color: t.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 },
  }

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>Track Settings</span>
          <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
        </div>
        <div style={S.body}>
          {tracks.length === 0 ? (
            <div style={{ padding: 16, color: t.textTertiary, fontSize: 12 }}>No tracks loaded.</div>
          ) : tracks.map(tr => (
            <div key={tr.id} style={{ ...S.trackRow, ...(selected.has(tr.id) ? S.trackRowSelected : {}) }} onClick={() => toggle(tr.id)}>
              <input type="checkbox" checked={selected.has(tr.id)} onChange={() => toggle(tr.id)} onClick={e => e.stopPropagation()} style={S.checkbox} />
              <span style={{ width: 10, height: 10, borderRadius: 2, background: tr.color, flexShrink: 0 }} />
              <span style={{ ...S.trackLabel, opacity: tr.visible ? 1 : 0.4 }}>{tr.name}</span>
              <span style={S.trackType}>{tr.track_type}</span>
            </div>
          ))}
        </div>

        {selectedTracks.length > 0 && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Edit {selectedTracks.length} selected track{selectedTracks.length > 1 ? 's' : ''}</div>

            <div style={S.controlRow}>
              <span style={S.controlLabel}>Color</span>
              <input type="color" value={commonColor} style={S.colorInput} onChange={e => applyToSelected({ color: e.target.value })} />
            </div>
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Height (px)</span>
              <input type="number" min={30} max={500} value={commonHeight} placeholder="mixed" style={S.input}
                onChange={e => { const v = parseInt(e.target.value); if (v >= 30) applyToSelected({ height: v }) }} />
            </div>
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Visible</span>
              <label style={S.cbLabel}>
                <input type="checkbox" checked={commonVisible === true}
                  ref={el => { if (el) el.indeterminate = commonVisible === null }}
                  onChange={e => applyToSelected({ visible: e.target.checked })} style={{ cursor: 'pointer' }} />
                Show
              </label>
            </div>

            {hasBars && (
              <>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Bar width</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonBarAutoWidth !== false}
                      ref={el => { if (el) el.indeterminate = commonBarAutoWidth === null }}
                      onChange={e => applyToSelected({ barAutoWidth: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    Auto
                  </label>
                </div>
                {commonBarAutoWidth === false && (
                  <div style={S.controlRow}>
                    <span style={S.controlLabel}></span>
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 24 }}>px</span>
                    <input type="number" min={1} max={50} step={1} value={commonBarWidth ?? 2} placeholder="px" style={S.input}
                      onChange={e => { const v = parseInt(e.target.value); if (v >= 1) applyToSelected({ barWidth: v }) }} />
                  </div>
                )}
              </>
            )}

            {hasAnnotation && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Gene style</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonArrows === true}
                    ref={el => { if (el) el.indeterminate = commonArrows === null }}
                    onChange={e => applyToSelected({ useArrows: e.target.checked })} style={{ cursor: 'pointer' }} />
                  Pointed arrows
                </label>
              </div>
            )}

            {hasCoverage && (
              <>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Y Scale</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={isAutoScale}
                      onChange={e => applyToSelected(e.target.checked ? { scaleMax: null, scaleMin: null } : { scaleMax: 100, scaleMin: 100 })}
                      style={{ cursor: 'pointer' }} />
                    Auto
                  </label>
                </div>
                {!isAutoScale && (
                  <div style={S.controlRow}>
                    <span style={S.controlLabel}></span>
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 40 }}>+Ymax</span>
                    <input type="number" min={1} step={10} value={commonScaleMax ?? ''} placeholder="max" style={S.input}
                      onChange={e => { const v = parseFloat(e.target.value); if (v > 0) applyToSelected({ scaleMax: v }) }} />
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 40 }}>{'\u2212'}Ymax</span>
                    <input type="number" min={1} step={10} value={commonScaleMin ?? ''} placeholder="min" style={S.input}
                      onChange={e => { const v = parseFloat(e.target.value); if (v > 0) applyToSelected({ scaleMin: v }) }} />
                  </div>
                )}
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Log scale</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonLogScale === true}
                      ref={el => { if (el) el.indeterminate = commonLogScale === null }}
                      onChange={e => applyToSelected({ logScale: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    log{'\u2082'}
                  </label>
                </div>
              </>
            )}
          </div>
        )}

        <div style={S.footer}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.smallBtn} onClick={selectAll}>Select all</button>
            <button style={S.smallBtn} onClick={selectNone}>Select none</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {selectedTracks.length > 0 && <button style={S.btnDanger} onClick={removeSelected}>Remove ({selectedTracks.length})</button>}
            <button style={S.btn} onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
