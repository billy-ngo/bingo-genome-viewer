/**
 * TrackWarningBadge.jsx — Small red "!" indicator for clipped/hidden data.
 *
 * Appears on track labels when bars are clipped or features overflow.
 * Hover shows a tooltip (via createPortal) explaining the issue.
 */
import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function TrackWarningBadge({ message, theme }) {
  const [showTip, setShowTip] = useState(false)
  const badgeRef = useRef(null)

  const tipPos = badgeRef.current
    ? badgeRef.current.getBoundingClientRect()
    : null

  return (
    <>
      <span
        ref={badgeRef}
        onMouseEnter={() => setShowTip(true)}
        onMouseLeave={() => setShowTip(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 12, height: 12, borderRadius: '50%',
          background: 'rgba(229, 57, 53, 0.85)',
          color: '#fff', fontSize: 9, fontWeight: 800,
          lineHeight: 1, cursor: 'default', flexShrink: 0,
          fontFamily: 'Arial, Helvetica, sans-serif',
        }}
      >
        !
      </span>
      {showTip && tipPos && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.min(tipPos.right + 6, window.innerWidth - 220),
          top: tipPos.top - 4,
          background: theme.tooltipBg || '#333',
          border: `1px solid ${theme.tooltipBorder || '#555'}`,
          borderRadius: 4,
          padding: '4px 8px',
          color: theme.textPrimary || '#e0e0e0',
          fontSize: 11,
          lineHeight: 1.4,
          maxWidth: 200,
          zIndex: 10001,
          pointerEvents: 'none',
          boxShadow: '0 3px 10px rgba(0,0,0,0.5)',
          whiteSpace: 'pre-wrap',
          fontFamily: 'Arial, Helvetica, sans-serif',
        }}>
          {message}
        </div>,
        document.body
      )}
    </>
  )
}
