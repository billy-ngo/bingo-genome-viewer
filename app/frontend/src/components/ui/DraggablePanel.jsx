/**
 * DraggablePanel.jsx — A floating, draggable, resizable panel.
 *
 * Does NOT use an overlay — the rest of the app remains interactive.
 * Only one instance of each panel type should be rendered at a time.
 *
 * Resizable from bottom-right, bottom-left, and top-left corners.
 * Content scales proportionally with panel width.
 */
import React, { useRef, useState, useCallback, useMemo } from 'react'

const MIN_W = 260
const MIN_H = 180
const SCALE_BASE_W = 440
const MIN_SCALE = 0.78
const MAX_SCALE = 1.4

export default function DraggablePanel({ title, onClose, theme, children, defaultWidth = 440, defaultHeight = 500 }) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, window.innerWidth - defaultWidth - 40),
    y: 80,
  }))
  const [size, setSize] = useState({ w: defaultWidth, h: Math.min(defaultHeight, window.innerHeight - 120) })
  const dragRef = useRef(null)
  const resizeRef = useRef(null)

  const scale = useMemo(() => {
    const raw = size.w / SCALE_BASE_W
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw))
  }, [size.w])

  const contentWidth = size.w / scale

  const onDragStart = useCallback((e) => {
    if (e.target.closest('input, select, button, label, textarea')) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPos: { ...pos } }
    function onMove(ev) {
      if (!dragRef.current) return
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.startPos.x + ev.clientX - dragRef.current.startX)),
        y: Math.max(0, Math.min(window.innerHeight - 40, dragRef.current.startPos.y + ev.clientY - dragRef.current.startY)),
      })
    }
    function onUp() {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [pos])

  // Generic corner resize handler
  // corner: 'br' (bottom-right), 'bl' (bottom-left), 'tl' (top-left)
  const onCornerResize = useCallback((e, corner) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = {
      startX: e.clientX, startY: e.clientY,
      startSize: { ...size }, startPos: { ...pos }, corner,
    }
    const cursors = { br: 'nwse-resize', bl: 'nesw-resize', tl: 'nwse-resize' }
    document.body.style.cursor = cursors[corner] || 'nwse-resize'

    function onMove(ev) {
      const r = resizeRef.current
      if (!r) return
      const dx = ev.clientX - r.startX
      const dy = ev.clientY - r.startY

      if (r.corner === 'br') {
        setSize({ w: Math.max(MIN_W, r.startSize.w + dx), h: Math.max(MIN_H, r.startSize.h + dy) })
      } else if (r.corner === 'bl') {
        const newW = Math.max(MIN_W, r.startSize.w - dx)
        const actualDx = r.startSize.w - newW
        setSize({ w: newW, h: Math.max(MIN_H, r.startSize.h + dy) })
        setPos(p => ({ ...p, x: r.startPos.x + actualDx }))
      } else if (r.corner === 'tl') {
        const newW = Math.max(MIN_W, r.startSize.w - dx)
        const newH = Math.max(MIN_H, r.startSize.h - dy)
        const actualDx = r.startSize.w - newW
        const actualDy = r.startSize.h - newH
        setSize({ w: newW, h: newH })
        setPos(p => ({ x: r.startPos.x + actualDx, y: r.startPos.y + actualDy }))
      }
    }
    function onUp() {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [size, pos])

  const handleStyle = {
    position: 'absolute', width: 14, height: 14, zIndex: 1,
  }

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, width: size.w, height: size.h,
      zIndex: 1000, background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
      borderRadius: 8, display: 'flex', flexDirection: 'column',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: `${6 * scale + 2}px ${12 * scale + 2}px`,
        borderBottom: `1px solid ${theme.border}`, cursor: 'grab', userSelect: 'none', flexShrink: 0,
      }} onMouseDown={onDragStart}>
        <span style={{ fontSize: Math.max(11, 13 * scale), fontWeight: 700, color: theme.textPrimary }}>{title}</span>
        <button style={{
          background: 'none', border: 'none', color: theme.textSecondary,
          cursor: 'pointer', fontSize: Math.max(14, 16 * scale), lineHeight: 1, padding: '0 4px',
        }} onClick={onClose}>{'\u2715'}</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        <div style={{
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'top left',
          width: scale !== 1 ? contentWidth : '100%',
        }}>
          {children}
        </div>
      </div>

      {/* Bottom-right resize handle */}
      <div
        style={{ ...handleStyle, right: 0, bottom: 0, cursor: 'nwse-resize' }}
        onMouseDown={e => onCornerResize(e, 'br')}
        title="Drag to resize"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: 'block' }}>
          <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke={theme.textTertiary} strokeWidth="1.5" fill="none" />
        </svg>
      </div>

      {/* Bottom-left resize handle */}
      <div
        style={{ ...handleStyle, left: 0, bottom: 0, cursor: 'nesw-resize' }}
        onMouseDown={e => onCornerResize(e, 'bl')}
        title="Drag to resize"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: 'block', transform: 'scaleX(-1)' }}>
          <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke={theme.textTertiary} strokeWidth="1.5" fill="none" />
        </svg>
      </div>

      {/* Top-left resize handle */}
      <div
        style={{ ...handleStyle, left: 0, top: 0, cursor: 'nwse-resize' }}
        onMouseDown={e => onCornerResize(e, 'tl')}
        title="Drag to resize"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: 'block', transform: 'rotate(180deg)' }}>
          <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke={theme.textTertiary} strokeWidth="1.5" fill="none" />
        </svg>
      </div>
    </div>
  )
}
