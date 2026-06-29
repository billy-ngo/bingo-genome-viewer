/**
 * OverlayTrackPanel.jsx — One row that renders an overlay GROUP of coverage
 * tracks stacked on top of each other.
 *
 * Each member is drawn on its own transparent canvas layer (CoverageTrack with
 * overlayRole='base'|'overlay'), sharing a single Y axis via computeAutoScale's
 * overlay-group handling. The label area shows a legend giving each member:
 *   - a color swatch (click to recolor),
 *   - an opacity slider (transparency),
 *   - up/down arrows (stacking hierarchy — later = drawn on top),
 *   - a show/hide toggle, and
 *   - a remove-from-overlay button.
 * The whole group drags/reorders and resizes as a single unit.
 */
import React, { useRef, useState, useCallback, Component } from 'react'
import { useTracks } from '../store/TrackContext'
import { useTheme } from '../store/ThemeContext'
import { useCanvasInteraction } from '../hooks/useCanvasInteraction'
import CoverageTrack from './tracks/CoverageTrack'
import SelectionOverlay from './ui/SelectionOverlay'
import PeakRankOverlay from './ui/PeakRankOverlay'
import { getLiveTrackData } from '../hooks/useTrackData'

class TrackErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null } }
  static getDerivedStateFromError(error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) {
      return <div style={{ padding: 8, color: '#ef9a9a', fontSize: 11 }}>Overlay error: {this.state.error?.message || 'Unknown error'}</div>
    }
    return this.props.children
  }
}

export default function OverlayTrackPanel({
  groupId, members, containerWidth, labelWidth = 140, onLabelResizeStart,
  isDragging, isDropTarget,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const { theme } = useTheme()
  const { updateTrack, reorderOverlayMember, removeFromOverlayGroup, dissolveOverlayGroup } = useTracks()
  const containerRef = useRef(null)
  const nativeColorRef = useRef(null)
  const colorTargetRef = useRef(null)

  // Host (first member) owns the row height and is the base layer.
  const host = members[0]
  const width = containerWidth - labelWidth
  const height = host.height
  const visibleMembers = members.filter(m => m.visible !== false)

  useCanvasInteraction(containerRef)

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    const startY = e.clientY
    const startHeight = host.height
    function onMouseMove(ev) {
      const newH = Math.max(40, Math.min(500, startHeight + (ev.clientY - startY)))
      updateTrack(host.id, { height: newH, autoHeight: false })
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''; document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [host.id, host.height, updateTrack])

  function openColorPicker(memberId, current) {
    colorTargetRef.current = memberId
    if (nativeColorRef.current) {
      nativeColorRef.current.value = current || '#78909c'
      nativeColorRef.current.click()
    }
  }

  const S = {
    row: { display: 'flex', borderBottom: `1px solid ${theme.border}`, minHeight: 40, flexShrink: 0 },
    label: {
      width: labelWidth, minWidth: labelWidth, background: theme.panelBg, borderRight: `1px solid ${theme.border}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 6px', overflow: 'hidden',
      position: 'relative', gap: 2,
    },
    trackArea: { flex: 1, overflow: 'hidden', position: 'relative', background: theme.canvasBg },
    iconBtn: {
      background: 'none', border: 'none', color: theme.textTertiary, cursor: 'pointer',
      fontSize: 10, lineHeight: 1, padding: '0 1px', flexShrink: 0,
    },
  }

  return (
    <div
      style={{
        ...S.row, height, position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        borderTop: isDropTarget ? '2px solid #888' : undefined,
      }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver?.() }}
      onDrop={e => { e.preventDefault(); onDrop?.() }}
      onDragEnd={onDragEnd}
    >
      <div style={S.label}>
        {/* Group header: drag handle + title + dissolve */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div
            draggable
            onDragStart={e => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', host.id)
              onDragStart?.()
            }}
            style={{ cursor: 'grab', color: theme.textMuted, fontSize: 14, lineHeight: 1, userSelect: 'none', flexShrink: 0 }}
            title="Drag to reorder the overlay group"
          >{'≡'}</div>
          <span style={{ fontSize: 10, fontWeight: 700, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
            Overlay · {members.length}
          </span>
          <span
            title="Separate overlay (ungroup tracks)"
            onClick={() => dissolveOverlayGroup(groupId)}
            style={{ color: theme.textTertiary, fontSize: 11, cursor: 'pointer', flexShrink: 0, padding: '0 2px' }}
            onMouseEnter={e => e.currentTarget.style.color = theme.textPrimary}
            onMouseLeave={e => e.currentTarget.style.color = theme.textTertiary}
          >{'⤢'}</span>
        </div>

        {/* Member legend — listed TOP-LAYER FIRST (the visual top of the legend
            is the track drawn on top), so ▲ moves a row up in both the list and
            the z-stack. Array order is bottom→top; we render it reversed. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto' }}>
          {members.map((m, ai) => ({ m, ai })).reverse().map(({ m, ai }) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, opacity: m.visible === false ? 0.45 : 1 }}>
              <span
                onClick={() => openColorPicker(m.id, m.color)}
                title="Click to change color"
                style={{ width: 9, height: 9, borderRadius: 2, background: m.color, cursor: 'pointer', flexShrink: 0, border: '1px solid rgba(255,255,255,0.25)' }}
              />
              <span style={{ flex: 1, color: theme.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.name}>{m.name}</span>
              <input
                type="range" min={0.1} max={1} step={0.05}
                value={m.overlayOpacity ?? 0.6}
                onChange={e => updateTrack(m.id, { overlayOpacity: parseFloat(e.target.value) })}
                title={`Opacity ${Math.round((m.overlayOpacity ?? 0.6) * 100)}%`}
                style={{ width: 40, flexShrink: 0, cursor: 'pointer', accentColor: m.color }}
              />
              <button style={S.iconBtn} title="Move up (draw on top)"
                onClick={() => reorderOverlayMember(m.id, +1)} disabled={ai === members.length - 1}>{'▲'}</button>
              <button style={S.iconBtn} title="Move down (draw under)"
                onClick={() => reorderOverlayMember(m.id, -1)} disabled={ai === 0}>{'▼'}</button>
              <button style={S.iconBtn} title={m.visible === false ? 'Show' : 'Hide'}
                onClick={() => updateTrack(m.id, { visible: m.visible === false })}>{m.visible === false ? '○' : '●'}</button>
              <button style={{ ...S.iconBtn, color: '#e57373' }} title="Remove from overlay"
                onClick={() => removeFromOverlayGroup(m.id)}>{'×'}</button>
            </div>
          ))}
        </div>

        {onLabelResizeStart && (
          <div
            onMouseDown={onLabelResizeStart}
            style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 10 }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          />
        )}
        <input
          ref={nativeColorRef}
          type="color"
          onChange={e => { if (colorTargetRef.current) updateTrack(colorTargetRef.current, { color: e.target.value }) }}
          style={{ position: 'absolute', left: -9999, top: -9999, opacity: 0, width: 0, height: 0 }}
        />
      </div>

      <div style={S.trackArea} ref={containerRef} data-export-overlay-group={groupId}>
        <TrackErrorBoundary>
          {visibleMembers.length === 0 ? (
            <div style={{ padding: 8, color: theme.textTertiary, fontSize: 11 }}>All overlay tracks hidden</div>
          ) : (
            visibleMembers.map((m, i) => (
              <div
                key={m.id}
                data-export-track-id={m.id}
                // No explicit zIndex: positioned siblings stack in DOM order, so
                // array order (base first) already gives bottom→top layering AND
                // keeps the Selection/Peak overlays (rendered after) on top.
                style={{ position: 'absolute', inset: 0 }}
              >
                <CoverageTrack
                  track={m}
                  width={width}
                  height={height}
                  overlayRole={i === 0 ? 'base' : 'overlay'}
                  barAlpha={m.overlayOpacity ?? 0.6}
                  overlayScaleMax={host.scaleMax}
                  overlayScaleMin={host.scaleMin}
                  overlayLogScale={host.logScale}
                />
              </div>
            ))
          )}
        </TrackErrorBoundary>
        <PeakRankOverlay width={width} height={height} />
        <SelectionOverlay
          width={width}
          height={height}
          trackData={getLiveTrackData(host.id)}
          trackType={host.track_type}
          trackId={host.id}
          regionOverlays={host.regionOverlays}
        />
      </div>

      <div
        onMouseDown={onResizeMouseDown}
        title="Drag to resize overlay height"
        style={{ position: 'absolute', left: 0, right: 0, bottom: -2, height: 5, cursor: 'ns-resize', zIndex: 10, background: 'transparent' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />
    </div>
  )
}
