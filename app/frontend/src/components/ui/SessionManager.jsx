/**
 * SessionManager.jsx — Save and restore viewer sessions.
 *
 * Auto-saves to localStorage on every state change. Supports manual export/import
 * as JSON files and "restore last session" on launch. Re-opens tracks via
 * backend /load-path endpoints without re-uploading files.
 */
import React, { useState, useRef } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import { genomeApi, tracksApi } from '../../api/client'

const SESSION_STORAGE_KEY = 'genomics-viewer-session'

/**
 * Collects the full session state from all contexts.
 * The genome file_path and each track's file_path are included so the backend
 * can re-open the readers on restore.
 */
function collectSession(genome, region, tracks, themeName, customTheme, labelWidth) {
  return {
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
      id: t.id,
      name: t.name,
      file_path: t.file_path,
      track_type: t.track_type,
      file_format: t.file_format,
      color: t.color,
      height: t.height,
      visible: t.visible,
      useArrows: t.useArrows,
      scaleMax: t.scaleMax,
      scaleMin: t.scaleMin,
      logScale: t.logScale,
      barAutoWidth: t.barAutoWidth,
      barWidth: t.barWidth,
    })),
    themeName,
    customTheme,
    labelWidth,
  }
}

export function useAutoSave(labelWidth) {
  const { genome, region } = useBrowser()
  const { tracks } = useTracks()
  const { themeName, customTheme } = useTheme()

  // Auto-save to localStorage on every meaningful change
  React.useEffect(() => {
    if (!genome) return
    const session = collectSession(genome, region, tracks, themeName, customTheme, labelWidth)
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    } catch {}
  }, [genome, region, tracks, themeName, customTheme, labelWidth])
}

export function getStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearStoredSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY)
}

export default function SessionManager({ onClose, labelWidth, setLabelWidth }) {
  const { genome, region, setGenome, navigateTo } = useBrowser()
  const { tracks, setTracks } = useTracks()
  const { theme, themeName, customTheme, setThemeName, setCustomTheme } = useTheme()
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [restoring, setRestoring] = useState(false)
  const fileRef = useRef(null)

  function handleSave() {
    const session = collectSession(genome, region, tracks, themeName, customTheme, labelWidth)
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `session-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus('Session saved')
    setTimeout(() => setStatus(null), 2000)
  }

  function handleLoadClick() {
    fileRef.current?.click()
  }

  async function handleFileLoad(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const session = JSON.parse(text)
      await restoreSession(session)
    } catch (err) {
      setError(`Failed to load session: ${err.message}`)
    }
  }

  async function handleRestoreAuto() {
    const session = getStoredSession()
    if (!session) {
      setError('No saved session found')
      return
    }
    await restoreSession(session)
  }

  async function restoreSession(session) {
    setRestoring(true)
    setError(null)
    setStatus('Restoring session...')
    try {
      // 1. Restore genome
      if (session.genome?.file_path) {
        try {
          const res = await genomeApi.loadPath(session.genome.file_path)
          const gInfo = res.data
          setGenome(gInfo)
        } catch (err) {
          throw new Error(`Genome load failed: ${err.response?.data?.detail || err.message}`)
        }
      }

      // 2. Restore tracks
      const restoredTracks = []
      const errors = []
      for (const saved of (session.tracks || [])) {
        if (saved.id === 'genome_annotations') {
          // Genome annotations are auto-created by genome load
          restoredTracks.push(saved)
          continue
        }
        if (!saved.file_path) { errors.push(`${saved.name}: no file path`); continue }
        try {
          const res = await tracksApi.loadPath(saved.file_path, saved.name)
          const backendInfo = res.data
          // Merge backend info (new id, file_path) with saved settings
          restoredTracks.push({
            ...saved,
            id: backendInfo.id,
            file_path: backendInfo.file_path,
            track_type: backendInfo.track_type,
            file_format: backendInfo.file_format,
          })
        } catch (err) {
          errors.push(`${saved.name}: ${err.response?.data?.detail || err.message}`)
        }
      }

      // Apply frontend track state (colors, heights, settings, order)
      setTracks(restoredTracks.map(t => ({
        ...t,
        height: t.height || 80,
        visible: t.visible !== false,
        useArrows: t.useArrows !== false,
        scaleMax: t.scaleMax ?? null,
        scaleMin: t.scaleMin ?? null,
        logScale: t.logScale || false,
        barAutoWidth: t.barAutoWidth !== false,
        barWidth: t.barWidth || 2,
        color: t.color || '#78909c',
      })))

      // 3. Restore theme
      if (session.themeName) setThemeName(session.themeName)
      if (session.customTheme) setCustomTheme(session.customTheme)

      // 4. Restore label width
      if (session.labelWidth && setLabelWidth) setLabelWidth(session.labelWidth)

      // 5. Restore region
      if (session.region) {
        setTimeout(() => navigateTo(session.region.chrom, session.region.start, session.region.end), 100)
      }

      if (errors.length) {
        setError(`Restored with ${errors.length} warning(s): ${errors.join('; ')}`)
      } else {
        setStatus('Session restored')
        setTimeout(() => { setStatus(null); onClose() }, 1500)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setRestoring(false)
    }
  }

  const storedSession = getStoredSession()
  const S = makeStyles(theme)

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>Session</span>
          <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
        </div>

        <div style={S.body}>
          {/* Save */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Save</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={S.btn} onClick={handleSave} disabled={!genome || restoring}>
                Save to file
              </button>
            </div>
            <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
              Session is also auto-saved to browser storage.
            </div>
          </div>

          {/* Restore */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Restore</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={S.btn} onClick={handleLoadClick} disabled={restoring}>
                Load from file
              </button>
              {storedSession && (
                <button style={S.btn} onClick={handleRestoreAuto} disabled={restoring}>
                  Restore last session
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileLoad} />
            {storedSession && (
              <div style={{ fontSize: 10, color: theme.textTertiary, marginTop: 4 }}>
                Last auto-save: {new Date(storedSession.savedAt).toLocaleString()}
                {storedSession.genome && ` \u2014 ${storedSession.genome.name}`}
                {storedSession.tracks && ` \u2014 ${storedSession.tracks.length} tracks`}
              </div>
            )}
          </div>

          {/* Status / Error */}
          {status && <div style={{ padding: '4px 16px', fontSize: 11, color: '#81c784' }}>{status}</div>}
          {error && <div style={{ padding: '4px 16px', fontSize: 11, color: '#ef9a9a', whiteSpace: 'pre-wrap' }}>{error}</div>}
        </div>

        <div style={S.footer}>
          <button style={S.btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function makeStyles(t) {
  return {
    overlay: {
      position: 'fixed', inset: 0, background: t.overlayBg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    },
    panel: {
      background: t.panelBg, border: `1px solid ${t.borderAccent}`, borderRadius: 8,
      padding: 0, minWidth: 380, maxWidth: 480, maxHeight: '80vh',
      display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    header: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
    },
    title: { fontSize: 14, fontWeight: 700, color: t.textPrimary },
    closeBtn: {
      background: 'none', border: 'none', color: t.textSecondary, cursor: 'pointer',
      fontSize: 18, lineHeight: 1, padding: '0 4px',
    },
    body: { padding: '8px 0', overflowY: 'auto', flex: 1 },
    section: { padding: '8px 16px' },
    sectionTitle: {
      fontSize: 11, color: t.textSecondary, textTransform: 'uppercase',
      letterSpacing: 1, marginBottom: 6,
    },
    btn: {
      background: t.btnBg, border: 'none', borderRadius: 4, color: t.btnText,
      padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    footer: {
      display: 'flex', justifyContent: 'flex-end', padding: '10px 16px',
      borderTop: `1px solid ${t.border}`,
    },
  }
}
