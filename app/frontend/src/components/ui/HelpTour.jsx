/**
 * HelpTour.jsx — Spotlight-based guided tour overlay.
 *
 * Each step highlights a specific UI element using four overlay strips
 * arranged around a spotlight cutout. A tooltip card positions itself
 * adjacent to the highlighted element.
 *
 * Keyboard: ArrowRight/Enter = next, ArrowLeft = prev, Escape = close.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'

const STEPS = [
  {
    target: 'file-loader',
    title: 'Load Files',
    description:
      'Select genome and track files using the file picker, drag and drop, or paste a local file path. ' +
      'Supported formats: FASTA, GenBank, BAM (+BAI), BigWig, WIG, BedGraph, VCF, BED, GTF, GFF.',
    position: 'bottom',
  },
  {
    target: 'nav-bar',
    title: 'Navigation & Scrubber',
    description:
      'Switch chromosomes, type coordinates (chr1:1000-5000) to jump, zoom with \uFF0D/\uFF0B, and pan with \u25C0/\u25B6. ' +
      'The blue scrubber bar shows your position \u2014 click or drag it to scroll across the entire chromosome.',
    position: 'bottom',
  },
  {
    target: 'track-area',
    title: 'Track Interaction',
    description:
      'Left-click drag to pan, scroll to zoom. Right-click drag to select a region \u2014 hover the blue highlight for stats. ' +
      'Double-click a gene to zoom in with context. Hover features for detailed tooltips.',
    position: 'inside',
  },
  {
    target: 'skeleton-track-label',
    title: 'Track Controls',
    description:
      'Drag \u2261 to reorder tracks, click the color swatch to change colors, and click \u00D7 to remove. ' +
      'Drag the bottom edge of a track to resize its height.',
    position: 'right',
  },
  {
    target: 'btn-settings',
    title: 'Track Settings',
    description:
      'Select tracks and adjust: height, color, Y-axis scale (auto/manual/log), bar width, peak outline trace with color picker, ' +
      'show/hide bars, pointed arrows, and nucleotide display for BAM reads (shows A/C/G/T with mismatch highlighting when zoomed in).',
    position: 'bottom',
    action: 'open-settings',
  },
  {
    target: 'header-btns',
    title: 'Themes',
    description:
      'Choose from built-in themes (Dark, Light, Colorblind, Soft, High Contrast) or create a fully custom theme. ' +
      'Theme preferences persist across sessions.',
    position: 'bottom',
    action: 'open-theme',
  },
  {
    target: 'btn-export',
    title: 'Export Image',
    description:
      'Export your current view as SVG or PNG. The export respects all track settings including peak outlines, bar visibility, and scale labels.',
    position: 'bottom',
  },
  {
    target: 'header-btns',
    title: 'Sessions',
    description:
      'Save Session exports your entire state (genome, tracks, region, zoom, colors, settings) as a JSON file. ' +
      'Restore it later or share with collaborators. Sessions also auto-save to your browser. ' +
      'An exit guard warns you before closing if you have unsaved work.',
    position: 'bottom',
  },
  {
    target: 'file-loader',
    title: 'Large File Tips',
    description:
      'For large BAM files, use the \uD83D\uDCC2 Path button to paste a local file path \u2014 the server reads directly from disk without uploading. ' +
      'For large WIG files, convert to BigWig format for instant loading. ' +
      'The app checks for updates automatically in the background.',
    position: 'bottom',
  },
]

const PAD = 8
const GAP = 14
const CARD_W = 340
const EST_CARD_H = 230
const DIM = 'rgba(0,0,0,0.55)'

export default function HelpTour({ onClose, theme, onAction }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const [cardH, setCardH] = useState(EST_CARD_H)
  const cardRef = useRef(null)

  const current = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  // Fire actions when entering a step (open panels briefly)
  useEffect(() => {
    const action = STEPS[step]?.action
    if (action && onAction) onAction(action)
  }, [step, onAction])

  // Close panels when leaving action steps
  const closeAction = useCallback((fromStep) => {
    const action = STEPS[fromStep]?.action
    if (action && onAction) onAction(null)
  }, [onAction])

  const next = useCallback(() => {
    closeAction(step)
    if (step < STEPS.length - 1) setStep(s => s + 1)
    else onClose()
  }, [step, onClose, closeAction])

  const prev = useCallback(() => {
    closeAction(step)
    if (step > 0) setStep(s => s - 1)
  }, [step, closeAction])

  // Keyboard navigation
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, next, prev])

  // Measure the target element
  useEffect(() => {
    function measure() {
      const el = document.querySelector(`[data-tour="${current.target}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
      } else {
        setRect(null)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [current.target])

  // Measure actual card height after render
  useEffect(() => {
    if (cardRef.current) {
      setCardH(cardRef.current.getBoundingClientRect().height)
    }
  })

  // Spotlight box (padded around target)
  const spot = rect ? {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  } : null

  // Compute card position
  let cardTop, cardLeft
  let arrowDir = null
  let arrowOffset = CARD_W / 2

  if (!rect) {
    cardTop = (window.innerHeight - cardH) / 2
    cardLeft = (window.innerWidth - CARD_W) / 2
  } else {
    const pos = current.position || 'bottom'
    const spotBottom = rect.top + rect.height + PAD
    const spotTop = rect.top - PAD
    const spotRight = rect.left + rect.width + PAD
    const targetCenterX = rect.left + rect.width / 2

    if (pos === 'inside') {
      cardTop = rect.top + Math.max(20, (rect.height - cardH) / 2)
      cardLeft = rect.left + Math.max(16, (rect.width - CARD_W) / 2)
    } else if (pos === 'right') {
      cardTop = rect.top + rect.height / 2 - cardH / 2
      cardLeft = spotRight + GAP
      arrowDir = 'left'
      arrowOffset = cardH / 2
      if (cardLeft + CARD_W > window.innerWidth - 12) {
        cardTop = spotBottom + GAP
        cardLeft = targetCenterX - CARD_W / 2
        arrowDir = 'up'
        arrowOffset = Math.max(20, Math.min(CARD_W - 20, targetCenterX - cardLeft))
      }
    } else {
      if (spotBottom + GAP + cardH <= window.innerHeight) {
        cardTop = spotBottom + GAP
        arrowDir = 'up'
      } else if (spotTop - GAP - cardH >= 0) {
        cardTop = spotTop - GAP - cardH
        arrowDir = 'down'
      } else {
        cardTop = spotBottom + GAP
        arrowDir = 'up'
      }

      if (rect.width < 200) {
        cardLeft = Math.max(12, rect.left + rect.width - CARD_W)
        if (cardLeft < 12) cardLeft = 12
      } else {
        cardLeft = targetCenterX - CARD_W / 2
      }
      arrowOffset = Math.max(20, Math.min(CARD_W - 20, targetCenterX - cardLeft))
    }

    cardLeft = Math.max(12, Math.min(window.innerWidth - CARD_W - 12, cardLeft))
    cardTop = Math.max(12, Math.min(window.innerHeight - cardH - 12, cardTop))
  }

  const S = {
    card: {
      position: 'fixed',
      top: cardTop,
      left: cardLeft,
      width: CARD_W,
      zIndex: 10002,
      background: theme.panelBg,
      border: `1px solid ${theme.borderAccent}`,
      borderRadius: 10,
      padding: '20px 24px 16px',
      color: theme.textPrimary,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    stepCounter: {
      fontSize: 11, fontWeight: 600, color: theme.textTertiary,
      textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 10,
    },
    title: {
      fontSize: 16, fontWeight: 700, marginBottom: 6, color: theme.textPrimary,
    },
    description: {
      fontSize: 13, lineHeight: 1.6, color: theme.textSecondary, marginBottom: 20,
    },
    dots: {
      display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 14,
    },
    dot: (active) => ({
      width: 7, height: 7, borderRadius: '50%',
      background: active ? '#42a5f5' : theme.borderStrong,
      cursor: 'pointer',
    }),
    nav: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    },
    btnPrimary: {
      background: '#1976d2', border: 'none', borderRadius: 5,
      color: '#fff', padding: '6px 18px', cursor: 'pointer',
      fontSize: 12, fontWeight: 600,
    },
    btnSecondary: {
      background: theme.btnBg, border: `1px solid ${theme.borderStrong}`,
      borderRadius: 5, color: theme.btnText, padding: '6px 14px',
      cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    btnDisabled: {
      background: theme.btnBg, border: `1px solid ${theme.border}`,
      borderRadius: 5, color: theme.textMuted, padding: '6px 14px',
      fontSize: 12, fontWeight: 600, cursor: 'default', opacity: 0.5,
    },
    skip: {
      background: 'none', border: 'none', color: theme.textTertiary,
      fontSize: 11, cursor: 'pointer', textDecoration: 'underline', padding: 0,
    },
    arrowUp: {
      position: 'absolute', top: -7, left: arrowOffset - 7,
      width: 0, height: 0,
      borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
      borderBottom: `7px solid ${theme.panelBg}`,
    },
    arrowDown: {
      position: 'absolute', bottom: -7, left: arrowOffset - 7,
      width: 0, height: 0,
      borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
      borderTop: `7px solid ${theme.panelBg}`,
    },
    arrowLeft: {
      position: 'absolute', left: -7, top: arrowOffset - 7,
      width: 0, height: 0,
      borderTop: '7px solid transparent', borderBottom: '7px solid transparent',
      borderRight: `7px solid ${theme.panelBg}`,
    },
  }

  return (
    <>
      {/* Click-capture layer */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 10000 }} onClick={onClose} />

      {/* Overlay: four strips around the spotlight cutout */}
      {spot ? (
        <>
          {/* Top strip */}
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: Math.max(0, spot.top), background: DIM, zIndex: 10001, pointerEvents: 'none' }} />
          {/* Bottom strip */}
          <div style={{ position: 'fixed', top: spot.top + spot.height, left: 0, right: 0, bottom: 0, background: DIM, zIndex: 10001, pointerEvents: 'none' }} />
          {/* Left strip */}
          <div style={{ position: 'fixed', top: spot.top, left: 0, width: Math.max(0, spot.left), height: spot.height, background: DIM, zIndex: 10001, pointerEvents: 'none' }} />
          {/* Right strip */}
          <div style={{ position: 'fixed', top: spot.top, left: spot.left + spot.width, right: 0, height: spot.height, background: DIM, zIndex: 10001, pointerEvents: 'none' }} />
          {/* Spotlight border */}
          <div style={{
            position: 'fixed', top: spot.top, left: spot.left, width: spot.width, height: spot.height,
            borderRadius: 6, border: '2px solid rgba(255,255,255,0.22)',
            zIndex: 10001, pointerEvents: 'none', boxSizing: 'border-box',
          }} />
        </>
      ) : (
        <div style={{ position: 'fixed', inset: 0, background: DIM, zIndex: 10001, pointerEvents: 'none' }} />
      )}

      {/* Tooltip card */}
      <div ref={cardRef} style={S.card} onClick={e => e.stopPropagation()}>
        {arrowDir === 'up' && <div style={S.arrowUp} />}
        {arrowDir === 'down' && <div style={S.arrowDown} />}
        {arrowDir === 'left' && <div style={S.arrowLeft} />}

        <div style={S.stepCounter}>Step {step + 1} of {STEPS.length}</div>
        <div style={S.title}>{current.title}</div>
        <div style={S.description}>{current.description}</div>

        <div style={S.dots}>
          {STEPS.map((_, i) => (
            <div key={i} style={S.dot(i === step)} onClick={() => setStep(i)} />
          ))}
        </div>

        <div style={S.nav}>
          <button style={S.skip} onClick={onClose}>Skip Tour</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={isFirst ? S.btnDisabled : S.btnSecondary}
              onClick={prev}
              disabled={isFirst}
            >Previous</button>
            <button style={S.btnPrimary} onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
