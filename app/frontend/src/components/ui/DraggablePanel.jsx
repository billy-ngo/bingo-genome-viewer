/**
 * DraggablePanel.jsx — A floating, draggable, resizable panel.
 *
 * Does NOT use an overlay — the rest of the app remains interactive.
 * Only one instance of each panel type should be rendered at a time.
 */
import React, { useRef, useState, useCallback, useEffect } from 'react'

const MIN_W = 320
const MIN_H = 200

export default function DraggablePanel({ title, onClose, theme, children, defaultWidth = 440, defaultHeight = 500 }) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, window.innerWidth - defaultWidth - 40),
    y: 80,
  }))
  const [size, setSize] = useState({ w: defaultWidth, h: Math.min(defaultHeight, window.innerHeight - 120) })
  const dragRef = useRef(null)
  const resizeRef = useRef(null)
  const panelRef = useRef(null)

  // Drag handler
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

  // Resize handler (bottom-right corner)
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
      padding: '8px 14px', borderBottom: `1px solid ${theme.border}`,
      cursor: 'grab', userSelect: 'none', flexShrink: 0,
    },
    title: { fontSize: 13, fontWeight: 700, color: theme.textPrimary },
    closeBtn: {
      background: 'none', border: 'none', color: theme.textSecondary,
      cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px',
    },
    body: {
      flex: 1, overflowY: 'auto', overflowX: 'hidden',
    },
    resizeHandle: {
      position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
      cursor: 'nwse-resize', zIndex: 1,
    },
  }

  return (
    <div ref={panelRef} style={S.panel}>
      <div style={S.header} onMouseDown={onDragStart}>
        <span style={S.title}>{title}</span>
        <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
      </div>
      <div style={S.body}>
        {children}
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
