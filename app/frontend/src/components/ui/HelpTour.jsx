/**
 * HelpTour.jsx — Guided tour overlay for new users.
 *
 * Displays a step-by-step walkthrough of the BiNgo Genome Viewer's
 * main features in a centered modal with navigation dots.
 */
import React, { useState, useCallback } from 'react'

const STEPS = [
  {
    icon: '\uD83D\uDCC2',
    title: 'File Loading',
    description:
      'Load your genome file (FASTA or GenBank) using the file picker, or drag and drop files anywhere on the screen.',
  },
  {
    icon: '\uD83E\uDDEC',
    title: 'Adding Tracks',
    description:
      'Once a genome is loaded, add track files (BAM, BigWig, WIG, VCF, BED, GFF) via the file picker or drag and drop.',
  },
  {
    icon: '\uD83E\uDDED',
    title: 'Navigation',
    description:
      'Use the navigation bar to switch chromosomes, enter coordinates, zoom in/out, and pan across the genome.',
  },
  {
    icon: '\uD83D\uDD0D',
    title: 'Track Interaction',
    description:
      'Click and drag on tracks to pan. Use the scroll wheel to zoom. Hover over features for details.',
  },
  {
    icon: '\u2699\uFE0F',
    title: 'Track Controls',
    description:
      'Each track has a label sidebar \u2014 drag \u2261 to reorder, click the color swatch to customize colors, and click \u00D7 to remove.',
  },
  {
    icon: '\uD83D\uDCBE',
    title: 'Settings & Export',
    description:
      'Use the toolbar buttons to save/restore sessions, change color themes, export views as images, and adjust track settings.',
  },
]

export default function HelpTour({ onClose, theme }) {
  const [step, setStep] = useState(0)

  const next = useCallback(() => {
    if (step < STEPS.length - 1) setStep(s => s + 1)
    else onClose()
  }, [step, onClose])

  const prev = useCallback(() => {
    if (step > 0) setStep(s => s - 1)
  }, [step])

  const current = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  const S = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
    },
    card: {
      background: theme.panelBg,
      border: `1px solid ${theme.borderAccent}`,
      borderRadius: 12,
      padding: '32px 36px 24px',
      maxWidth: 460,
      width: '90%',
      color: theme.textPrimary,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      position: 'relative',
    },
    stepCounter: {
      fontSize: 11,
      fontWeight: 600,
      color: theme.textTertiary,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      marginBottom: 16,
    },
    iconRow: {
      fontSize: 36,
      marginBottom: 12,
      lineHeight: 1,
    },
    title: {
      fontSize: 18,
      fontWeight: 700,
      marginBottom: 10,
      color: theme.textPrimary,
    },
    description: {
      fontSize: 14,
      lineHeight: 1.65,
      color: theme.textSecondary,
      marginBottom: 28,
    },
    dots: {
      display: 'flex',
      justifyContent: 'center',
      gap: 8,
      marginBottom: 20,
    },
    dot: (active) => ({
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: active ? '#42a5f5' : theme.borderStrong,
      transition: 'background 0.2s',
      cursor: 'pointer',
    }),
    nav: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    btnPrimary: {
      background: '#1976d2',
      border: 'none',
      borderRadius: 5,
      color: '#fff',
      padding: '7px 20px',
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: 600,
    },
    btnSecondary: {
      background: theme.btnBg,
      border: `1px solid ${theme.borderStrong}`,
      borderRadius: 5,
      color: theme.btnText,
      padding: '7px 16px',
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: 600,
    },
    btnDisabled: {
      background: theme.btnBg,
      border: `1px solid ${theme.border}`,
      borderRadius: 5,
      color: theme.textMuted,
      padding: '7px 16px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'default',
      opacity: 0.5,
    },
    skip: {
      background: 'none',
      border: 'none',
      color: theme.textTertiary,
      fontSize: 12,
      cursor: 'pointer',
      textDecoration: 'underline',
      padding: 0,
    },
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.card} onClick={e => e.stopPropagation()}>
        <div style={S.stepCounter}>Step {step + 1} of {STEPS.length}</div>
        <div style={S.iconRow}>{current.icon}</div>
        <div style={S.title}>{current.title}</div>
        <div style={S.description}>{current.description}</div>

        <div style={S.dots}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              style={S.dot(i === step)}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div style={S.nav}>
          <button
            style={S.skip}
            onClick={onClose}
          >
            Skip Tour
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={isFirst ? S.btnDisabled : S.btnSecondary}
              onClick={prev}
              disabled={isFirst}
            >
              Previous
            </button>
            <button
              style={S.btnPrimary}
              onClick={next}
            >
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
