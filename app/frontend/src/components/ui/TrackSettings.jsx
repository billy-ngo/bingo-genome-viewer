/**
 * TrackSettings.jsx — Bulk track configuration panel.
 *
 * Allows adjusting visibility, height, color, scale (linear/log),
 * Y-axis range, and bar width for selected tracks.
 */
import React, { useState, useRef } from 'react'
import { useTracks, DEFAULT_ANNOTATION_COLORS } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import DraggablePanel from './DraggablePanel'

// Ordered by hue: reds → oranges → yellows → greens → cyans → blues → purples → grays
const ORDERED_COLORS = [
  '#f44336', '#e53935', '#ef5350', '#e57373',
  '#ff5722', '#ff8a65', '#ff9800', '#ffa726', '#ffb74d',
  '#ffc107', '#ffd54f', '#fff176',
  '#4caf50', '#66bb6a', '#81c784', '#aed581',
  '#009688', '#26c6da', '#4dd0e1', '#80cbc4',
  '#2196f3', '#42a5f5', '#64b5f6',
  '#3f51b5', '#7e57c2', '#9575cd',
  '#9c27b0', '#ab47bc', '#ce93d8',
  '#e91e63', '#f06292',
  '#795548', '#8d6e63',
  '#607d8b', '#78909c',
]

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
  const hasReads = selectedTracks.some(t => t.track_type === 'reads')
  const hasVariants = selectedTracks.some(t => t.track_type === 'variants')
  const hasBars = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads' || t.track_type === 'variants')
  const hasCoverageBars = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads')

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
  const commonShowOutline = selectedTracks.length > 0 && selectedTracks.every(t => t.showOutline === selectedTracks[0].showOutline) ? selectedTracks[0].showOutline : null
  const commonOutlineColor = selectedTracks.length > 0 && selectedTracks.every(t => t.outlineColor === selectedTracks[0].outlineColor) ? selectedTracks[0].outlineColor : undefined
  const commonOutlineSmooth = selectedTracks.length > 0 && selectedTracks.every(t => t.outlineSmooth === selectedTracks[0].outlineSmooth) ? selectedTracks[0].outlineSmooth : undefined
  const commonShowBars = selectedTracks.length > 0 && selectedTracks.every(t => t.showBars === selectedTracks[0].showBars) ? selectedTracks[0].showBars : null
  const commonShowNucleotides = selectedTracks.length > 0 && selectedTracks.every(t => t.showNucleotides === selectedTracks[0].showNucleotides) ? selectedTracks[0].showNucleotides : null
  const commonFwdColor = selectedTracks.length > 0 && selectedTracks.every(t => (t.fwdColor || '#90a4ae') === (selectedTracks[0].fwdColor || '#90a4ae')) ? (selectedTracks[0].fwdColor || '#90a4ae') : undefined
  const commonRevColor = selectedTracks.length > 0 && selectedTracks.every(t => (t.revColor || '#f06292') === (selectedTracks[0].revColor || '#f06292')) ? (selectedTracks[0].revColor || '#f06292') : undefined
  const commonArrowStyle = selectedTracks.length > 0 && selectedTracks.every(t => (t.arrowStyle || 'pointed') === (selectedTracks[0].arrowStyle || 'pointed')) ? (selectedTracks[0].arrowStyle || 'pointed') : undefined
  const commonArrowSize = selectedTracks.length > 0 && selectedTracks.every(t => (t.arrowSize || 4) === (selectedTracks[0].arrowSize || 4)) ? (selectedTracks[0].arrowSize || 4) : undefined

  function applyToSelected(updates) { updateMultipleTracks([...selected], updates) }
  function removeSelected() { for (const id of selected) removeTrack(id); setSelected(new Set()) }

  const t = theme
  const S = {
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
    <DraggablePanel title="Track Settings" onClose={onClose} theme={t} defaultWidth={460} defaultHeight={520}>
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

            {/* 1. Height */}
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Height (px)</span>
              <input type="range" min={30} max={500} step={1} value={commonHeight || 80}
                onChange={e => applyToSelected({ height: parseInt(e.target.value) })}
                style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
              <input type="text" inputMode="numeric" value={commonHeight} placeholder="mixed" style={{ ...S.input, width: 48 }}
                onChange={e => { const v = parseInt(e.target.value); if (v >= 30 && v <= 500) applyToSelected({ height: v }) }}
                onBlur={e => { const v = parseInt(e.target.value); if (!v || v < 30) applyToSelected({ height: 30 }); if (v > 500) applyToSelected({ height: 500 }) }} />
            </div>

            {/* 2. Visible */}
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Visible</span>
              <label style={S.cbLabel}>
                <input type="checkbox" checked={commonVisible === true}
                  ref={el => { if (el) el.indeterminate = commonVisible === null }}
                  onChange={e => applyToSelected({ visible: e.target.checked })} style={{ cursor: 'pointer' }} />
                Show
              </label>
            </div>

            {/* 3. Fill bars + color (coverage/read tracks only, not variants) */}
            {hasCoverageBars && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Fill bars</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonShowBars !== false}
                    ref={el => { if (el) el.indeterminate = commonShowBars === null }}
                    onChange={e => applyToSelected({ showBars: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Show
                </label>
                {commonShowBars !== false && (
                  <input type="color" value={commonColor} style={S.colorInput}
                    onChange={e => applyToSelected({ color: e.target.value })}
                    title="Bar fill color" />
                )}
              </div>
            )}

            {/* Color for variant and other non-coverage, non-annotation tracks */}
            {(hasVariants || (!hasBars && !hasAnnotation)) && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Color</span>
                <input type="color" value={commonColor} style={S.colorInput} onChange={e => applyToSelected({ color: e.target.value })} />
              </div>
            )}

            {/* 4. Bar width (bar tracks only) */}
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
                    <input type="range" min={1} max={50} step={1} value={commonBarWidth ?? 2}
                      onChange={e => applyToSelected({ barWidth: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <input type="number" min={1} max={50} step={1} value={commonBarWidth ?? 2} style={{ ...S.input, width: 48 }}
                      onChange={e => { const v = parseInt(e.target.value); if (v >= 1 && v <= 50) applyToSelected({ barWidth: v }) }} />
                    <span style={{ fontSize: 11, color: t.textTertiary }}>px</span>
                  </div>
                )}
              </>
            )}

            {/* 5. Peak outline (coverage/read tracks only, not variants) */}
            {hasCoverageBars && (
              <>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Peak outline</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonShowOutline === true}
                      ref={el => { if (el) el.indeterminate = commonShowOutline === null }}
                      onChange={e => applyToSelected({ showOutline: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    Trace peaks
                  </label>
                  {commonShowOutline === true && (
                    <input type="color" value={commonOutlineColor || commonColor || '#ffffff'}
                      onChange={e => applyToSelected({ outlineColor: e.target.value })}
                      title="Outline color"
                      style={{ width: 22, height: 18, border: 'none', background: 'none', cursor: 'pointer', padding: 0, marginLeft: 4 }} />
                  )}
                </div>
                {commonShowOutline === true && (
                  <div style={S.controlRow}>
                    <span style={S.controlLabel}>Smoothness</span>
                    <input type="range" min={0} max={10} step={1} value={commonOutlineSmooth ?? 0}
                      onChange={e => applyToSelected({ outlineSmooth: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 24, textAlign: 'right' }}>{commonOutlineSmooth ?? 0}</span>
                  </div>
                )}
              </>
            )}

            {/* 6. Y Scale (coverage tracks only) */}
            {hasCoverage && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Y Scale</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={isAutoScale}
                    onChange={e => applyToSelected(e.target.checked ? { scaleMax: null, scaleMin: null } : { scaleMax: 100, scaleMin: 100 })}
                    style={{ cursor: 'pointer' }} />
                  Auto
                </label>
              </div>
            )}
            {hasCoverage && !isAutoScale && (
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

            {/* 7. Log2 (coverage tracks only) */}
            {hasCoverage && (
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
            )}

            {/* ── Type-specific sections ────────────────────── */}

            {/* Annotation colors */}
            {hasAnnotation && (
              <AnnotationColorSection tracks={selectedTracks} applyToSelected={applyToSelected} theme={t} />
            )}

            {/* Gene style */}
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

            {/* Nucleotides */}
            {(hasReads || hasAnnotation) && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Nucleotides</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonShowNucleotides !== false}
                    ref={el => { if (el) el.indeterminate = commonShowNucleotides === null }}
                    onChange={e => applyToSelected({ showNucleotides: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Show when zoomed in
                </label>
              </div>
            )}

            {/* Read Appearance */}
            {hasReads && (
              <>
                <div style={{ ...S.sectionTitle, marginTop: 12 }}>Read Appearance</div>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Strand colors</span>
                  <span style={{ fontSize: 10, color: t.textTertiary, marginRight: 2 }}>{'\u25B6'}</span>
                  <input type="color" value={commonFwdColor || '#90a4ae'}
                    onChange={e => applyToSelected({ fwdColor: e.target.value })}
                    title="Forward strand color"
                    style={{ width: 22, height: 18, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                  <span style={{ fontSize: 10, color: t.textTertiary, marginLeft: 6, marginRight: 2 }}>{'\u25C0'}</span>
                  <input type="color" value={commonRevColor || '#f06292'}
                    onChange={e => applyToSelected({ revColor: e.target.value })}
                    title="Reverse strand color"
                    style={{ width: 22, height: 18, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
                  <button style={{ ...S.smallBtn, marginLeft: 'auto' }}
                    onClick={() => applyToSelected({ fwdColor: null, revColor: null })}
                    title="Reset to defaults"
                  >Reset</button>
                </div>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Arrow style</span>
                  <select value={commonArrowStyle || 'pointed'}
                    onChange={e => applyToSelected({ arrowStyle: e.target.value })}
                    style={{ background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}>
                    <option value="pointed">Pointed</option>
                    <option value="chevron">Chevron</option>
                    <option value="fade">Fade</option>
                    <option value="flat">Flat (none)</option>
                  </select>
                </div>
                {(commonArrowStyle || 'pointed') !== 'flat' && (
                  <div style={S.controlRow}>
                    <span style={S.controlLabel}>Arrow size</span>
                    <input type="range" min={2} max={12} step={1} value={commonArrowSize || 4}
                      onChange={e => applyToSelected({ arrowSize: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 20, textAlign: 'right' }}>{commonArrowSize || 4}</span>
                  </div>
                )}
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
          </div>
        </div>
    </DraggablePanel>
  )
}

const ANNOTATION_TYPES = [
  { key: 'cds', label: 'CDS' },
  { key: 'exon', label: 'Exon' },
  { key: 'gene', label: 'Gene' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'utr', label: 'UTR' },
  { key: 'rrna', label: 'rRNA' },
  { key: 'trna', label: 'tRNA' },
  { key: 'repeat', label: 'Repeat' },
  { key: 'default', label: 'Other' },
]

function AnnotationColorSection({ tracks, applyToSelected, theme }) {
  const [expandedType, setExpandedType] = useState(null)
  const nativeRef = useRef(null)
  const [nativeTarget, setNativeTarget] = useState(null) // key being edited via native picker

  // Use first selected track's annotation colors as the baseline
  const overrides = tracks[0]?.annotationColors || {}

  function resolveColor(key) {
    return overrides[key] || DEFAULT_ANNOTATION_COLORS[key] || '#80cbc4'
  }

  function setColor(key, color) {
    for (const t of tracks) {
      const updated = { ...(t.annotationColors || {}), [key]: color }
      applyToSelected({ annotationColors: updated })
    }
  }

  function resetAll() {
    applyToSelected({ annotationColors: null })
  }

  function openNativePicker(key) {
    setNativeTarget(key)
    if (nativeRef.current) {
      nativeRef.current.value = resolveColor(key)
      nativeRef.current.click()
    }
  }

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 0 0 0' }}>
        <span style={{ fontSize: 12, color: theme.textSecondary, width: 90 }}>Annotation colors</span>
        <button
          style={{ background: 'none', border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
            color: theme.textTertiary, cursor: 'pointer', fontSize: 10, padding: '1px 6px' }}
          onClick={resetAll}
        >Reset</button>
      </div>
      {ANNOTATION_TYPES.map(({ key, label }) => {
        const current = resolveColor(key)
        return (
          <div key={key}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
                cursor: 'pointer', fontSize: 11, color: theme.textPrimary, borderRadius: 3,
              }}
              onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => setExpandedType(expandedType === key ? null : key)}
            >
              <span
                style={{
                  width: 14, height: 14, borderRadius: 3, background: current,
                  border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0, cursor: 'pointer',
                }}
                onDoubleClick={(e) => { e.stopPropagation(); openNativePicker(key) }}
                title="Click to expand swatches, double-click for full color picker"
              />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{ fontSize: 9, color: theme.textTertiary }}>
                {expandedType === key ? '\u25B2' : '\u25BC'}
              </span>
            </div>
            {expandedType === key && (
              <div style={{ padding: '3px 4px 6px 24px', display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                {ORDERED_COLORS.map(c => (
                  <span
                    key={c}
                    style={{
                      width: 16, height: 16, borderRadius: 3, background: c, cursor: 'pointer',
                      border: c === current ? `2px solid ${theme.textPrimary}` : '1px solid rgba(255,255,255,0.1)',
                      boxSizing: 'border-box',
                    }}
                    onClick={() => { setColor(key, c); setExpandedType(null) }}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
      <input
        ref={nativeRef}
        type="color"
        style={{ position: 'absolute', left: -9999, top: -9999, opacity: 0, width: 0, height: 0 }}
        onChange={(e) => { if (nativeTarget) setColor(nativeTarget, e.target.value) }}
      />
    </div>
  )
}
