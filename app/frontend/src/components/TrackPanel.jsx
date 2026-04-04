/**
 * TrackPanel.jsx — Container for a single track row.
 *
 * Renders the label sidebar (track name, color swatch, drag handle) and
 * the appropriate canvas track component (Coverage, Annotation, Read, Variant).
 * Supports drag-to-reorder, inline color picker, and warning badges.
 */
import React, { useRef, useState, useCallback, Component } from 'react'
import { createPortal } from 'react-dom'
import { useTracks, DEFAULT_ANNOTATION_COLORS } from '../store/TrackContext'
import { useTheme } from '../store/ThemeContext'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import CoverageTrack from './tracks/CoverageTrack'
import ReadTrack from './tracks/ReadTrack'
import AnnotationTrack from './tracks/AnnotationTrack'
import VariantTrack from './tracks/VariantTrack'
import TrackWarningBadge from './ui/TrackWarningBadge'
import SelectionOverlay from './ui/SelectionOverlay'
import { getLiveTrackData } from '../hooks/useTrackData'

class TrackErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null } }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) {
      return <div style={{ padding: 8, color: '#ef9a9a', fontSize: 11 }}>Track error: {this.state.error?.message || 'Unknown error'}</div>
    }
    return this.props.children
  }
}

export default function TrackPanel({
  track, containerWidth, labelWidth = 140, onLabelResizeStart,
  isDragging, isDropTarget,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const { theme } = useTheme()
  const { updateTrack, removeTrack } = useTracks()
  const containerRef = useRef(null)
  const resizeRef = useRef(null)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [showAnnotationPicker, setShowAnnotationPicker] = useState(false)
  const [warning, setWarning] = useState(null)
  const colorSwatchRef = useRef(null)
  const nativeColorRef = useRef(null)

  const isAnnotation = track.track_type === 'annotations' || track.track_type === 'genome_annotations'
  useCanvasInteraction(containerRef)

  const QUICK_COLORS = [
    '#78909c', '#66bb6a', '#42a5f5', '#ffa726', '#f06292',
    '#ab47bc', '#26c6da', '#ef5350', '#8d6e63', '#fff176',
    '#ff8a65', '#80cbc4', '#9575cd', '#aed581', '#4dd0e1',
    '#e57373', '#ffb74d', '#81c784', '#64b5f6', '#ce93d8',
  ]

  const width = containerWidth - labelWidth

  const S = {
    row: { display: 'flex', borderBottom: `1px solid ${theme.border}`, minHeight: 40 },
    label: {
      width: labelWidth, minWidth: labelWidth, background: theme.panelBg, borderRight: `1px solid ${theme.border}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 8px', overflow: 'hidden',
      position: 'relative',
    },
    trackName: { fontSize: 11, color: theme.trackName, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    trackType: { fontSize: 10, color: theme.textTertiary, marginTop: 2 },
    trackArea: { flex: 1, overflow: 'hidden', position: 'relative' },
  }

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    const startY = e.clientY
    const startHeight = track.height
    function onMouseMove(ev) {
      const newH = Math.max(30, Math.min(500, startHeight + (ev.clientY - startY)))
      updateTrack(track.id, { height: newH })
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''; document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [track.id, track.height, updateTrack])

  function renderTrack() {
    const props = { track, width, height: track.height, onWarning: setWarning }
    switch (track.track_type) {
      case 'reads': return <ReadTrack {...props} />
      case 'coverage': return <CoverageTrack {...props} />
      case 'variants': return <VariantTrack {...props} />
      case 'annotations':
      case 'genome_annotations': return <AnnotationTrack {...props} />
      default: return <div style={{ padding: 8, color: theme.textTertiary, fontSize: 11 }}>Unknown track type</div>
    }
  }

  return (
    <div
      style={{
        ...S.row, height: track.height, position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        borderTop: isDropTarget ? '2px solid #888' : undefined,
      }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver?.() }}
      onDrop={e => { e.preventDefault(); onDrop?.() }}
      onDragEnd={onDragEnd}
    >
      <div style={S.label}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div
            draggable
            onDragStart={e => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', track.id)
              onDragStart?.()
            }}
            style={{ cursor: 'grab', color: theme.textMuted, fontSize: 14, lineHeight: 1, userSelect: 'none', flexShrink: 0, padding: '0 2px' }}
            title="Drag to reorder tracks"
          >{'\u2261'}</div>
          <div ref={colorSwatchRef}>
            {isAnnotation ? (
              <>
                <span
                  style={{
                    display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                    background: '#888', cursor: 'pointer', verticalAlign: 'middle',
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundImage: 'linear-gradient(135deg, #ef5350 25%, #66bb6a 25%, #66bb6a 50%, #42a5f5 50%, #42a5f5 75%, #ffa726 75%)',
                  }}
                  title="Click to customize annotation colors"
                  onMouseDown={e => { e.stopPropagation(); setShowAnnotationPicker(p => !p) }}
                />
                {showAnnotationPicker && createPortal(
                  <AnnotationColorEditor
                    track={track}
                    theme={theme}
                    anchorRef={colorSwatchRef}
                    onClose={() => setShowAnnotationPicker(false)}
                    onChange={(key, color) => {
                      const updated = { ...(track.annotationColors || {}), [key]: color }
                      updateTrack(track.id, { annotationColors: updated })
                    }}
                    onReset={() => updateTrack(track.id, { annotationColors: null })}
                  />,
                  document.body
                )}
              </>
            ) : (
              <>
                <span
                  style={{
                    display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                    background: track.color, cursor: 'pointer', verticalAlign: 'middle',
                    border: '1px solid rgba(255,255,255,0.2)',
                  }}
                  title="Click to pick color, double-click for full palette"
                  onMouseDown={e => { e.stopPropagation(); setShowColorPicker(true) }}
                  onDoubleClick={e => { e.stopPropagation(); setShowColorPicker(false); nativeColorRef.current?.click() }}
                />
                <input
                  ref={nativeColorRef}
                  type="color"
                  value={track.color || '#78909c'}
                  onChange={e => updateTrack(track.id, { color: e.target.value })}
                  style={{ position: 'absolute', left: -9999, top: -9999, opacity: 0, width: 0, height: 0 }}
                />
                {showColorPicker && createPortal(
                  <div
                    style={{
                      position: 'fixed',
                      left: colorSwatchRef.current ? colorSwatchRef.current.getBoundingClientRect().left : 0,
                      top: colorSwatchRef.current ? colorSwatchRef.current.getBoundingClientRect().bottom + 4 : 0,
                      zIndex: 10001,
                      background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
                      borderRadius: 4, padding: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                      display: 'grid', gridTemplateColumns: 'repeat(5, 18px)', gap: 3,
                    }}
                    onMouseLeave={() => setShowColorPicker(false)}
                  >
                    {QUICK_COLORS.map(c => (
                      <span
                        key={c}
                        style={{
                          width: 18, height: 18, borderRadius: 3, background: c, cursor: 'pointer',
                          border: c === track.color ? `2px solid ${theme.textPrimary}` : '1px solid rgba(255,255,255,0.15)',
                          boxSizing: 'border-box',
                        }}
                        onMouseUp={() => { updateTrack(track.id, { color: c }); setShowColorPicker(false) }}
                      />
                    ))}
                  </div>,
                  document.body
                )}
              </>
            )}
          </div>
          <div style={{ ...S.trackName, flex: 1 }} title={track.name}>
            {track.name}
          </div>
          <span
            title="Remove track"
            onClick={e => { e.stopPropagation(); removeTrack(track.id) }}
            style={{
              color: '#e53935', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              lineHeight: 1, flexShrink: 0, padding: '0 2px', opacity: 0.7,
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
            onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
          >{'\u00d7'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={S.trackType}>{track.file_format} · {track.track_type}</div>
          {warning && <TrackWarningBadge message={warning} theme={theme} />}
        </div>
        {onLabelResizeStart && (
          <div
            onMouseDown={onLabelResizeStart}
            style={{
              position: 'absolute', right: -3, top: 0, bottom: 0, width: 6,
              cursor: 'ew-resize', zIndex: 10,
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          />
        )}
      </div>
      <div style={S.trackArea} ref={containerRef}>
        <TrackErrorBoundary>{renderTrack()}</TrackErrorBoundary>
        <SelectionOverlay
          width={width}
          height={track.height}
          trackData={getLiveTrackData(track.id)}
          trackType={track.track_type}
        />
      </div>
      <div
        ref={resizeRef}
        onMouseDown={onResizeMouseDown}
        title="Drag to resize track height"
        style={{ position: 'absolute', left: 0, right: 0, bottom: -2, height: 5, cursor: 'ns-resize', zIndex: 10, background: 'transparent' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />
    </div>
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

const ANNO_QUICK_COLORS = [
  '#66bb6a', '#42a5f5', '#7e57c2', '#ab47bc', '#26c6da',
  '#ffa726', '#ef5350', '#8d6e63', '#80cbc4', '#78909c',
  '#4caf50', '#2196f3', '#9c27b0', '#e91e63', '#00bcd4',
  '#ff9800', '#f44336', '#795548', '#009688', '#607d8b',
  '#aed581', '#64b5f6', '#ce93d8', '#f06292', '#4dd0e1',
]

// Maps annotation color key → theme property name
const ANNO_KEY_TO_THEME = {
  cds: 'geneCds', exon: 'geneExon', gene: 'geneGene',
  transcript: 'geneTranscript', utr: 'geneUtr',
  rrna: 'geneRrna', trna: 'geneTrna',
  repeat: 'geneRepeat', default: 'geneDefault',
}

function AnnotationColorEditor({ track, theme, anchorRef, onClose, onChange, onReset }) {
  const [expandedType, setExpandedType] = useState(null)
  const overrides = track.annotationColors || {}
  const rect = anchorRef.current?.getBoundingClientRect()

  // Resolve the effective color: per-track override → theme → hardcoded fallback
  function resolveColor(key) {
    return overrides[key] || theme[ANNO_KEY_TO_THEME[key]] || DEFAULT_ANNOTATION_COLORS[key]
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: rect ? Math.min(rect.left, window.innerWidth - 220) : 0,
        top: rect ? rect.bottom + 4 : 0,
        zIndex: 10001,
        background: theme.panelBg,
        border: `1px solid ${theme.borderAccent}`,
        borderRadius: 6,
        padding: '8px 0',
        boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        width: 210,
        maxHeight: 340,
        overflowY: 'auto',
      }}
      onMouseLeave={onClose}
    >
      <div style={{
        fontSize: 10, fontWeight: 700, color: theme.textSecondary, textTransform: 'uppercase',
        letterSpacing: 1, padding: '0 10px 6px', borderBottom: `1px solid ${theme.border}`, marginBottom: 4,
      }}>
        Annotation Colors
      </div>
      {ANNOTATION_TYPES.map(({ key, label }) => {
        const current = resolveColor(key)
        return (
          <div key={key}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
                cursor: 'pointer', fontSize: 11, color: theme.textPrimary,
              }}
              onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => setExpandedType(expandedType === key ? null : key)}
            >
              <span style={{
                display: 'inline-block', width: 14, height: 14, borderRadius: 3,
                background: current,
                border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0,
              }} />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{ fontSize: 9, color: theme.textTertiary }}>
                {expandedType === key ? '\u25B2' : '\u25BC'}
              </span>
            </div>
            {expandedType === key && (
              <div style={{
                padding: '4px 10px 6px 32px',
                display: 'grid', gridTemplateColumns: 'repeat(5, 18px)', gap: 3,
              }}>
                {ANNO_QUICK_COLORS.map(c => (
                  <span
                    key={c}
                    style={{
                      width: 18, height: 18, borderRadius: 3, background: c, cursor: 'pointer',
                      border: c === current
                        ? `2px solid ${theme.textPrimary}` : '1px solid rgba(255,255,255,0.15)',
                      boxSizing: 'border-box',
                    }}
                    onClick={() => { onChange(key, c); setExpandedType(null) }}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div style={{ borderTop: `1px solid ${theme.border}`, marginTop: 4, paddingTop: 4 }}>
        <div
          style={{
            padding: '4px 10px', fontSize: 10, color: theme.textTertiary, cursor: 'pointer',
            textAlign: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = theme.textPrimary }}
          onMouseLeave={e => { e.currentTarget.style.color = theme.textTertiary }}
          onClick={onReset}
        >
          Reset to defaults
        </div>
      </div>
    </div>
  )
}
