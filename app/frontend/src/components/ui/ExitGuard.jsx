/**
 * ExitGuard.jsx — Warns users before leaving the app (tab close, navigate away,
 * or accidental file drop over the tab).
 *
 * Renders a modal with three options:
 *   - Return to app
 *   - Exit without saving
 *   - Save session and exit
 *
 * Clicking outside the dialog returns the user to the app.
 */
import React, { useEffect, useState, useCallback } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

const SESSION_STORAGE_KEY = 'genomics-viewer-session'

export default function ExitGuard({ labelWidth }) {
  const { genome, region } = useBrowser()
  const { tracks } = useTracks()
  const { theme, themeName, customTheme } = useTheme()
  const [showPrompt, setShowPrompt] = useState(false)
  const [saving, setSaving] = useState(false)

  // Track whether the app has meaningful state worth protecting
  const hasState = Boolean(genome)

  // ── Browser beforeunload: shows native "Leave site?" dialog ──
  useEffect(() => {
    if (!hasState) return
    function onBeforeUnload(e) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasState])

  // ── Keyboard: warn on Ctrl+W / Cmd+W ──
  useEffect(() => {
    if (!hasState) return
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault()
        setShowPrompt(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hasState])

  const handleReturn = useCallback(() => setShowPrompt(false), [])

  const handleExitWithoutSaving = useCallback(() => {
    // Remove beforeunload so the tab actually closes
    window.onbeforeunload = null
    window.close()
    // If window.close() doesn't work (not opened by script), navigate away
    window.location.href = 'about:blank'
  }, [])

  const handleSaveAndExit = useCallback(() => {
    setSaving(true)
    try {
      // Save to localStorage (same format as auto-save)
      const session = {
        version: 1,
        savedAt: new Date().toISOString(),
        genome: genome ? {
          name: genome.name,
          file_path: genome.file_path,
          chromosomes: genome.chromosomes,
          is_annotated: genome.is_annotated,
        } : null,
        region,
        tracks: tracks.map(t => ({
          id: t.id, name: t.name, file_path: t.file_path,
          track_type: t.track_type, file_format: t.file_format,
          color: t.color, height: t.height, visible: t.visible,
          useArrows: t.useArrows, scaleMax: t.scaleMax, scaleMin: t.scaleMin,
          logScale: t.logScale, barAutoWidth: t.barAutoWidth, barWidth: t.barWidth,
          annotationColors: t.annotationColors,
          targetChromosomes: t.targetChromosomes || null,
        })),
        themeName,
        customTheme,
        labelWidth,
      }
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))

      // Also trigger file download
      const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `session-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
    setSaving(false)

    // Close after saving
    window.onbeforeunload = null
    window.close()
    window.location.href = 'about:blank'
  }, [genome, region, tracks, themeName, customTheme, labelWidth])

  // Expose trigger for other components (e.g., a close button)
  ExitGuard.show = () => setShowPrompt(true)

  if (!showPrompt) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={handleReturn}
    >
      <div
        style={{
          background: theme.panelBg,
          border: `1px solid ${theme.borderAccent}`,
          borderRadius: 8,
          padding: '24px 28px',
          maxWidth: 400, width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
          Leave BiNgo Genome Viewer?
        </div>
        <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.7, marginBottom: 20 }}>
          You have an active session with{' '}
          <strong style={{ color: theme.textPrimary }}>{tracks.length} track{tracks.length !== 1 ? 's' : ''}</strong> loaded.
          Unsaved changes will be lost.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={handleReturn}
            style={{
              background: '#1976d2', border: 'none', borderRadius: 4,
              color: '#fff', padding: '8px 16px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, width: '100%',
            }}
          >
            Return to App
          </button>
          <button
            onClick={handleSaveAndExit}
            disabled={saving}
            style={{
              background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
              color: theme.btnText, padding: '8px 16px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, width: '100%',
            }}
          >
            {saving ? 'Saving...' : 'Save Session & Exit'}
          </button>
          <button
            onClick={handleExitWithoutSaving}
            style={{
              background: 'transparent', border: `1px solid ${theme.border}`, borderRadius: 4,
              color: '#e57373', padding: '8px 16px', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, width: '100%',
            }}
          >
            Exit Without Saving
          </button>
        </div>
      </div>
    </div>
  )
}
