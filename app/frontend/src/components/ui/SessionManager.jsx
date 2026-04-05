/**
 * SessionManager.jsx — Save and restore viewer sessions.
 *
 * Auto-saves to localStorage on every state change. Supports manual export/import
 * as JSON files and "restore last session" on launch. Re-opens tracks via
 * backend /load-path endpoints without re-uploading files.
 */
import React, { useState, useRef } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import { genomeApi, tracksApi } from '../../api/client'

const SESSION_STORAGE_KEY = 'genomics-viewer-session'
const SESSION_VERSION = 2

// ── Public helpers (shared with ExitGuard, etc.) ─────────────────────────

/**
 * Collects the full session state from all contexts.
 * The genome file_path and each track's file_path are included so the backend
 * can re-open the readers on restore.
 */
export function collectSession(genome, region, tracks, themeName, customTheme, labelWidth) {
  return {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    genome: genome ? {
      name: genome.name,
      file_path: genome.file_path,
      chromosomes: genome.chromosomes,
      is_annotated: genome.is_annotated,
      annotated_chromosomes: genome.annotated_chromosomes || null,
    } : null,
    region: region ? { chrom: region.chrom, start: region.start, end: region.end } : null,
    tracks: tracks.map((t, idx) => ({
      id: t.id,
      name: t.name,
      file_path: t.file_path,
      track_type: t.track_type,
      file_format: t.file_format,
      color: t.color,
      height: t.height,
      visible: t.visible,
      useArrows: t.useArrows,
      scaleMax: t.scaleMax ?? null,
      scaleMin: t.scaleMin ?? null,
      logScale: t.logScale || false,
      barAutoWidth: t.barAutoWidth !== false,
      barWidth: t.barWidth || 2,
      showOutline: t.showOutline || false,
      annotationColors: t.annotationColors || null,
      targetChromosomes: t.targetChromosomes || null,
      order: idx,
    })),
    themeName,
    customTheme: customTheme || null,
    labelWidth,
  }
}

/** Save session object to localStorage. Returns true on success. */
export function saveSessionToStorage(session) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    return true
  } catch {
    return false
  }
}

/** Download session as a JSON file. */
export function downloadSessionFile(session) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const genomeName = session.genome?.name || 'untitled'
  a.download = `bingo-session-${genomeName}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
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

/**
 * Validate that a session object has the required shape.
 * Returns { valid: boolean, error?: string }.
 */
function validateSession(session) {
  if (!session || typeof session !== 'object') {
    return { valid: false, error: 'Invalid session file — not a JSON object' }
  }
  if (!session.genome) {
    return { valid: false, error: 'Session file has no genome data' }
  }
  if (!session.genome.file_path) {
    return { valid: false, error: 'Session file missing genome file path' }
  }
  if (!Array.isArray(session.tracks)) {
    return { valid: false, error: 'Session file has no track list' }
  }
  return { valid: true }
}

// ── Auto-save hook ───────────────────────────────────────────────────────

export function useAutoSave(labelWidth) {
  const { genome, region } = useBrowser()
  const { tracks } = useTracks()
  const { themeName, customTheme } = useTheme()

  React.useEffect(() => {
    if (!genome) return
    const session = collectSession(genome, region, tracks, themeName, customTheme, labelWidth)
    saveSessionToStorage(session)
  }, [genome, region, tracks, themeName, customTheme, labelWidth])
}

// ── Component ────────────────────────────────────────────────────────────

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
    saveSessionToStorage(session)
    downloadSessionFile(session)
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
      let session
      try {
        session = JSON.parse(text)
      } catch {
        setError('Invalid file — not valid JSON')
        return
      }
      const check = validateSession(session)
      if (!check.valid) {
        setError(check.error)
        return
      }
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
    const check = validateSession(session)
    if (!check.valid) {
      setError(check.error)
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
      let genomeInfo = null
      if (session.genome?.file_path) {
        try {
          setStatus('Loading genome...')
          const res = await genomeApi.loadPath(session.genome.file_path)
          genomeInfo = res.data
          setGenome(genomeInfo)
        } catch (err) {
          throw new Error(`Genome load failed: ${err.response?.data?.detail || err.message}`)
        }
      }

      // 2. Restore tracks — load in parallel for speed
      setStatus('Loading tracks...')
      const savedTracks = session.tracks || []
      const trackPromises = savedTracks.map(async (saved) => {
        if (saved.id === 'genome_annotations' || saved.track_type === 'genome_annotations') {
          return { saved, backend: null, ok: true }
        }
        if (!saved.file_path) {
          return { saved, error: 'no file path', ok: false }
        }
        try {
          const res = await tracksApi.loadPath(saved.file_path, saved.name)
          return { saved, backend: res.data, ok: true }
        } catch (err) {
          return { saved, error: err.response?.data?.detail || err.message, ok: false }
        }
      })

      const results = await Promise.allSettled(trackPromises)

      const restoredTracks = []
      const errors = []

      for (const result of results) {
        const { saved, backend, ok, error: errMsg } = result.status === 'fulfilled' ? result.value : { saved: null, ok: false, error: 'unknown' }
        if (!ok) {
          errors.push(`${saved?.name || 'unknown'}: ${errMsg}`)
          continue
        }
        if (backend) {
          // Merge backend info (new id, file_path) with saved UI settings
          restoredTracks.push({
            ...saved,
            id: backend.id,
            file_path: backend.file_path,
            track_type: backend.track_type,
            file_format: backend.file_format,
            targetChromosomes: backend.target_chromosomes || saved.targetChromosomes || null,
          })
        } else {
          // genome_annotations — keep saved settings
          restoredTracks.push(saved)
        }
      }

      // Sort by saved order to preserve track arrangement
      restoredTracks.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))

      // Apply frontend track state (colors, heights, settings)
      setTracks(restoredTracks.map(t => ({
        ...t,
        name: cleanName(t.name) || t.name,
        height: t.height || 80,
        visible: t.visible !== false,
        useArrows: t.useArrows !== false,
        scaleMax: t.scaleMax ?? null,
        scaleMin: t.scaleMin ?? null,
        logScale: t.logScale || false,
        barAutoWidth: t.barAutoWidth !== false,
        barWidth: t.barWidth || 2,
      showOutline: t.showOutline || false,
        color: t.color || '#78909c',
        annotationColors: t.annotationColors || null,
        targetChromosomes: t.targetChromosomes || null,
      })))

      // 3. Restore theme
      if (session.themeName) setThemeName(session.themeName)
      if (session.customTheme) setCustomTheme(session.customTheme)

      // 4. Restore label width
      if (session.labelWidth && setLabelWidth) setLabelWidth(session.labelWidth)

      // 5. Restore region — wait for genome to be ready in genomeRef
      if (session.region && genomeInfo) {
        // genomeRef is updated synchronously in setGenome, so navigateTo
        // can find the chromosome immediately. Use requestAnimationFrame
        // to ensure React has flushed the state update for rendering.
        requestAnimationFrame(() => {
          navigateTo(session.region.chrom, session.region.start, session.region.end)
        })
      }

      if (errors.length) {
        setError(
          `Restored with ${errors.length} warning(s):\n${errors.join('\n')}\n\n` +
          `Tip: If files were moved, re-add them using the \u{1F4C2} Path button.`
        )
      } else {
        setStatus('Session restored')
        setTimeout(() => { setStatus(null); onClose() }, 1200)
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
