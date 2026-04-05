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

const B = (t) => <strong>{t}</strong>
const Li = ({ children }) => <div style={{ display: 'flex', gap: 6, marginTop: 4 }}><span style={{ opacity: 0.5 }}>{'\u2022'}</span><span>{children}</span></div>
const Kbd = ({ children }) => <span style={{ background: 'rgba(255,255,255,0.1)', borderRadius: 3, padding: '0 4px', fontSize: 11, fontFamily: 'monospace' }}>{children}</span>

const STEPS = [
  {
    target: 'file-loader',
    title: 'Load Files',
    description: <>
      Upload genome and track files via:
      <Li>{B('File picker')} — click "Choose Files"</Li>
      <Li>{B('Drag & drop')} — drop files anywhere on the app</Li>
      <Li>{B('Local path')} — paste a file path (best for large files)</Li>
      <div style={{ marginTop: 8, opacity: 0.7 }}>
        Supported: FASTA, GenBank, BAM, BigWig, WIG, BedGraph, VCF, BED, GTF, GFF
      </div>
    </>,
    position: 'bottom',
  },
  {
    target: 'nav-bar',
    title: 'Navigation',
    description: <>
      <Li>{B('Chromosome selector')} — switch between chromosomes</Li>
      <Li>{B('Coordinate input')} — type <Kbd>chr1:1000-5000</Kbd> and press Go</Li>
      <Li>{B('\uFF0D \uFF0B')} — zoom out / zoom in</Li>
      <Li>{B('\u25C0 \u25B6')} — pan left / pan right</Li>
      <Li>{B('Blue scrubber bar')} — click or drag to jump across the chromosome</Li>
    </>,
    position: 'bottom',
  },
  {
    target: 'track-area',
    title: 'Track Interaction',
    description: <>
      <Li>{B('Left-click drag')} — pan the viewport</Li>
      <Li>{B('Scroll wheel')} — zoom in/out at cursor position</Li>
      <Li>{B('Right-click drag')} — select a region (hover for stats)</Li>
      <Li>{B('Double-click gene')} — zoom to fit that gene with context</Li>
      <Li>{B('Hover features')} — view detailed tooltips</Li>
    </>,
    position: 'inside',
  },
  {
    target: 'skeleton-track-label',
    title: 'Track Labels',
    description: <>
      <Li>{B('\u2261 Drag handle')} — reorder tracks by dragging</Li>
      <Li>{B('Color swatch')} — click to pick a color</Li>
      <Li>{B('\u00D7 Button')} — remove the track</Li>
      <Li>{B('Bottom edge')} — drag to resize track height</Li>
    </>,
    position: 'right',
  },
  {
    target: 'btn-settings',
    title: 'Track Settings',
    description: <>
      Select one or more tracks to adjust:
      <Li>Height, visibility, and fill color</Li>
      <Li>Bar width, peak outline trace + smoothness</Li>
      <Li>Y-axis scale (auto / manual / log{'\u2082'})</Li>
      <Li>Annotation colors per feature type</Li>
      <Li>Read appearance — strand colors, arrow style & size</Li>
      <Li>Nucleotide display with mismatch highlighting</Li>
      <div style={{ marginTop: 6, opacity: 0.7 }}>The panel is draggable — adjust settings while viewing your data.</div>
    </>,
    position: 'bottom',
    action: 'open-settings',
  },
  {
    target: 'header-btns',
    title: 'Themes',
    description: <>
      <Li>{B('5 built-in themes')} — Dark, Light, Colorblind, Soft, High Contrast</Li>
      <Li>{B('Custom themes')} — clone any preset and edit every color</Li>
      <div style={{ marginTop: 6, opacity: 0.7 }}>Theme preferences persist across sessions.</div>
    </>,
    position: 'bottom',
    action: 'open-theme',
  },
  {
    target: 'btn-export',
    title: 'Export Image',
    description: <>
      Export the current view as {B('SVG')} or {B('PNG')}.
      <Li>Background, bars, outlines, and labels are separate SVG groups</Li>
      <Li>All track settings (colors, outlines, visibility) are respected</Li>
      <Li>Edit exported SVGs in Illustrator, Inkscape, or Figma</Li>
    </>,
    position: 'bottom',
  },
  {
    target: 'header-btns',
    title: 'Sessions',
    description: <>
      <Li>{B('Save to file')} — exports genome, tracks, region, zoom, colors, and all settings as JSON</Li>
      <Li>{B('Restore')} — reload a saved session or the last auto-save</Li>
      <Li>{B('Auto-save')} — your session saves to the browser automatically</Li>
      <div style={{ marginTop: 6, opacity: 0.7 }}>An exit guard warns you before closing with unsaved work.</div>
    </>,
    position: 'bottom',
  },
  {
    target: 'file-loader',
    title: 'Tips',
    description: <>
      <Li>{B('Large BAM files')} — use the <Kbd>{'\uD83D\uDCC2'} Path</Kbd> button to load by file path (no upload needed)</Li>
      <Li>{B('Large WIG files')} — convert to BigWig for instant loading</Li>
      <Li>{B('BAM + BAI')} — select both together, or load by path (index auto-discovered)</Li>
      <Li>{B('Updates')} — the app checks for updates automatically on launch</Li>
    </>,
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
