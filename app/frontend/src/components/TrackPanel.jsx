/**
 * TrackPanel.jsx — Container for a single track row.
 *
 * Renders the label sidebar (track name, color swatch, drag handle) and
 * the appropriate canvas track component (Coverage, Annotation, Read, Variant).
 * Supports drag-to-reorder, inline color picker, and warning badges.
 */
import React, { useRef, useState, useCallback, Component } from 'react'
import { createPortal } from 'react-dom'
import { useTracks } from '../store/TrackContext'
import { useTheme } from '../store/ThemeContext'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import CoverageTrack from './tracks/CoverageTrack'
import ReadTrack from './tracks/ReadTrack'
import AnnotationTrack from './tracks/AnnotationTrack'
import VariantTrack from './tracks/VariantTrack'
import TrackWarningBadge from './ui/TrackWarningBadge'

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
  const { updateTrack } = useTracks()
  const containerRef = useRef(null)
  const resizeRef = useRef(null)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [warning, setWarning] = useState(null)
  const colorSwatchRef = useRef(null)
  const nativeColorRef = useRef(null)
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
            title="Drag to reorder"
          >{'\u2261'}</div>
          <div ref={colorSwatchRef}>
            <span
              style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                background: track.color, cursor: 'pointer', verticalAlign: 'middle',
                border: '1px solid rgba(255,255,255,0.2)',
              }}
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
          </div>
          <div style={{ ...S.trackName, flex: 1 }} title={track.name}>
            {track.name}
          </div>
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
      </div>
      <div
        ref={resizeRef}
        onMouseDown={onResizeMouseDown}
        style={{ position: 'absolute', left: 0, right: 0, bottom: -2, height: 5, cursor: 'ns-resize', zIndex: 10, background: 'transparent' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />
    </div>
  )
}
