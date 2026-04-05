/**
 * DraggablePanel.jsx — A floating, draggable, resizable panel.
 *
 * Does NOT use an overlay — the rest of the app remains interactive.
 * Only one instance of each panel type should be rendered at a time.
 *
 * Content scales with panel width (down to a minimum font size),
 * then switches to scrolling when the panel is too small to scale further.
 */
import React, { useRef, useState, useCallback, useMemo } from 'react'

const MIN_W = 260
const MIN_H = 180
const SCALE_BASE_W = 440     // width at which scale = 1.0
const MIN_SCALE = 0.78       // don't scale below this (keeps text ≥ ~11px)
const MAX_SCALE = 1.4        // don't scale above this

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

  // Content width in logical pixels (before scaling)
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

  const onResizeStart = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startSize: { ...size } }
    function onMove(ev) {
      if (!resizeRef.current) return
      setSize({
        w: Math.max(MIN_W, resizeRef.current.startSize.w + ev.clientX - resizeRef.current.startX),
        h: Math.max(MIN_H, resizeRef.current.startSize.h + ev.clientY - resizeRef.current.startY),
      })
    }
    function onUp() {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'nwse-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [size])

  const S = {
    panel: {
      position: 'fixed',
      left: pos.x, top: pos.y,
      width: size.w, height: size.h,
      zIndex: 1000,
      background: theme.panelBg,
      border: `1px solid ${theme.borderAccent}`,
      borderRadius: 8,
      display: 'flex', flexDirection: 'column',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      overflow: 'hidden',
    },
    header: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: `${6 * scale + 2}px ${12 * scale + 2}px`,
      borderBottom: `1px solid ${theme.border}`,
      cursor: 'grab', userSelect: 'none', flexShrink: 0,
    },
    title: { fontSize: Math.max(11, 13 * scale), fontWeight: 700, color: theme.textPrimary },
    closeBtn: {
      background: 'none', border: 'none', color: theme.textSecondary,
      cursor: 'pointer', fontSize: Math.max(14, 16 * scale), lineHeight: 1, padding: '0 4px',
    },
    body: {
      flex: 1, overflowY: 'auto', overflowX: 'hidden',
    },
    scaledContent: {
      transform: scale !== 1 ? `scale(${scale})` : undefined,
      transformOrigin: 'top left',
      width: scale !== 1 ? contentWidth : '100%',
    },
    resizeHandle: {
      position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
      cursor: 'nwse-resize', zIndex: 1,
    },
  }

  return (
    <div style={S.panel}>
      <div style={S.header} onMouseDown={onDragStart}>
        <span style={S.title}>{title}</span>
        <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
      </div>
      <div style={S.body}>
        <div style={S.scaledContent}>
          {children}
        </div>
      </div>
      <div
        style={S.resizeHandle}
        onMouseDown={onResizeStart}
        title="Drag to resize"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: 'block' }}>
          <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke={theme.textTertiary} strokeWidth="1.5" fill="none" />
        </svg>
      </div>
    </div>
  )
}
