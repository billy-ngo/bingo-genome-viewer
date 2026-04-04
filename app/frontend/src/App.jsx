/**
 * App.jsx — Root component and layout shell.
 *
 * Provides context providers (Browser, Track, Theme), renders the header
 * toolbar, navigation bar, ruler, track panels, and all modal dialogs.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react'
import { BrowserProvider, useBrowser } from './store/BrowserContext'
import { TrackProvider, useTracks, cleanName } from './store/TrackContext'
import { ThemeProvider, useTheme } from './store/ThemeContext'
import { genomeApi } from './api/client'
import FileLoader from './components/ui/FileLoader'
import TrackSettings from './components/ui/TrackSettings'
import ThemeSettings from './components/ui/ThemeSettings'
import ExportImage from './components/ui/ExportImage'
import SessionManager, { useAutoSave } from './components/ui/SessionManager'
import HelpTour from './components/ui/HelpTour'
import NavigationBar from './components/NavigationBar'
import RulerTrack from './components/RulerTrack'
import TrackPanel from './components/TrackPanel'
import ExitGuard from './components/ui/ExitGuard'

const APP_VERSION = '1.4.2'

function BingoLogo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
      <defs>
        <radialGradient id="ballGrad" cx="35%" cy="30%" r="65%">
          <stop offset="0%" stopColor="#5eb8ff"/>
          <stop offset="50%" stopColor="#1976d2"/>
          <stop offset="100%" stopColor="#0d47a1"/>
        </radialGradient>
        <radialGradient id="shine" cx="30%" cy="25%" r="30%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.7)"/>
          <stop offset="100%" stopColor="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>
      {/* Ball body */}
      <circle cx="50" cy="50" r="48" fill="url(#ballGrad)"/>
      {/* White center circle */}
      <circle cx="50" cy="48" r="28" fill="white"/>
      {/* Blue ring around center */}
      <circle cx="50" cy="48" r="28" fill="none" stroke="#1565c0" strokeWidth="2.5"/>
      {/* BN text at top */}
      <text x="50" y="39" textAnchor="middle" fontSize="13" fontWeight="800" fontFamily="Arial, sans-serif" fill="#0d47a1">BN</text>
      {/* Number 1 */}
      <text x="50" y="64" textAnchor="middle" fontSize="30" fontWeight="900" fontFamily="Arial, sans-serif" fill="#0d47a1">1</text>
      {/* Glossy highlight */}
      <circle cx="50" cy="50" r="48" fill="url(#shine)"/>
    </svg>
  )
}

/**
 * SkeletonTrack — An empty placeholder track row always visible when
 * no real tracks are loaded, so users can see the track layout.
 */
function SkeletonTrack({ theme, labelWidth }) {
  const trackH = 60
  return (
    <div style={{ display: 'flex', borderBottom: `1px solid ${theme.border}`, height: trackH, opacity: 0.45 }}>
      <div
        data-tour="skeleton-track-label"
        style={{
          width: labelWidth, minWidth: labelWidth, background: theme.panelBg,
          borderRight: `1px solid ${theme.border}`, padding: '6px 8px',
          display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14, color: theme.textTertiary, userSelect: 'none', lineHeight: 1 }}>{'\u2261'}</span>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#78909c', flexShrink: 0 }} />
          <span style={{
            fontSize: 11, fontWeight: 600, color: theme.textSecondary, flex: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>Track Name</span>
          <span style={{ fontSize: 13, color: theme.textTertiary, lineHeight: 1, padding: '0 2px' }}>{'\u00D7'}</span>
        </div>
      </div>
      <div style={{ flex: 1, background: theme.canvasBg }} />
    </div>
  )
}

function BrowserApp() {
  const { theme } = useTheme()
  const { genome, region, setGenome, navigateTo } = useBrowser()
  const { tracks, reorderTracks, addTrack, uploadTrack, commitTrack, discardTrack, addGenomeAnnotationTrack, restoreAnnotationTracks } = useTracks()
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [showSettings, setShowSettings] = useState(false)
  const [showTheme, setShowTheme] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSession, setShowSession] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showTour, setShowTour] = useState(false)
  const [labelWidth, setLabelWidth] = useState(140)
  const [dragTrackId, setDragTrackId] = useState(null)
  const [dropTrackId, setDropTrackId] = useState(null)
  const [appDragOver, setAppDragOver] = useState(false)
  const [dropStatus, setDropStatus] = useState(null)
  const [dropPrompt, setDropPrompt] = useState(null) // { files: File[] }
  const [dropTrackMismatch, setDropTrackMismatch] = useState(null) // { tracks: [...] }
  const appDragCounter = useRef(0)

  useAutoSave(labelWidth)

  // Heartbeat — keeps the backend server alive while any tab is open.
  // When all tabs close the heartbeats stop and the server auto-exits.
  useEffect(() => {
    const ping = () => fetch('/api/heartbeat').catch(() => {})
    ping()
    const id = setInterval(ping, 10_000)
    return () => clearInterval(id)
  }, [])

  // Restore hidden genome annotation tracks when the user switches chromosomes.
  const prevChromRef = useRef(region?.chrom)
  useEffect(() => {
    if (region?.chrom && region.chrom !== prevChromRef.current) {
      prevChromRef.current = region.chrom
      restoreAnnotationTracks()
    }
  }, [region?.chrom, restoreAnnotationTracks])

  // Full-screen drag-and-drop support
  const GENOME_EXTS = new Set(['.gb', '.gbk', '.genbank', '.fasta', '.fa'])
  const TRACK_EXTS = new Set(['.bam', '.bw', '.bigwig', '.wig', '.bedgraph', '.bdg', '.vcf', '.bed', '.gtf', '.gff', '.gff2', '.gff3'])

  function getFileExt(name) {
    if (!name) return ''
    if (name.toLowerCase().endsWith('.vcf.gz')) return '.vcf.gz'
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(dot).toLowerCase() : ''
  }

  const onAppDragEnter = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    // Only show drop overlay for external file drops, not internal track reorder drags
    if (!e.dataTransfer?.types?.includes('Files')) return
    appDragCounter.current++
    if (appDragCounter.current === 1) setAppDragOver(true)
  }, [])

  const onAppDragLeave = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    if (!e.dataTransfer?.types?.includes('Files')) return
    appDragCounter.current--
    if (appDragCounter.current <= 0) { appDragCounter.current = 0; setAppDragOver(false) }
  }, [])

  const onAppDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation() }, [])

  function isTrackMismatch(info) {
    const c = info?.compatibility
    return c && c.status !== 'ok' && c.status !== 'no_genome'
  }

  const onAppDrop = useCallback(async (e) => {
    e.preventDefault(); e.stopPropagation()
    appDragCounter.current = 0
    setAppDragOver(false)

    // Ignore internal drags (track reorder)
    if (!e.dataTransfer?.types?.includes('Files')) return

    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return

    const genomeFiles = []
    const trackFiles = []
    const unknownFiles = []

    for (const f of files) {
      const ext = getFileExt(f.name)
      if (GENOME_EXTS.has(ext)) genomeFiles.push(f)
      else if (TRACK_EXTS.has(ext) || ext === '.vcf.gz') trackFiles.push(f)
      else unknownFiles.push(f)
    }

    if (unknownFiles.length && !genomeFiles.length && !trackFiles.length) {
      setDropStatus({ error: `Unsupported file${unknownFiles.length > 1 ? 's' : ''}: ${unknownFiles.map(f => f.name).join(', ')}` })
      setTimeout(() => setDropStatus(null), 4000)
      return
    }

    try {
      if (genomeFiles.length > 0 && !genome) {
        setDropStatus({ msg: `Loading genome: ${genomeFiles[0].name}...` })
        const res = await genomeApi.load(genomeFiles[0])
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        setGenome(info)
        if (info.chromosomes?.length > 0) {
          const chr = info.chromosomes[0]
          navigateTo(chr.name, 0, Math.min(chr.length, 50000))
        }
        if (info.is_annotated) {
          addGenomeAnnotationTrack({
            id: 'genome_annotations', name: `${info.name} (annotations)`,
            track_type: 'genome_annotations', file_format: 'genbank',
            targetChromosomes: info.annotated_chromosomes || null,
          })
        }
      } else if (genomeFiles.length > 0 && genome) {
        // Genome already loaded — prompt user
        setDropPrompt({ files: genomeFiles })
      }

      if (trackFiles.length > 0) {
        if (!genome && genomeFiles.length === 0) {
          setDropStatus({ error: 'Load a genome file first (.fasta, .gb, .genbank)' })
          setTimeout(() => setDropStatus(null), 4000)
          return
        }
        setDropStatus({ msg: `Loading ${trackFiles.length} track${trackFiles.length > 1 ? 's' : ''}...` })
        const compatible = []
        const incompatible = []
        const errors = []
        for (const file of trackFiles) {
          try {
            const info = await uploadTrack(file, undefined)
            if (isTrackMismatch(info)) {
              incompatible.push(info)
            } else {
              commitTrack(info)
              compatible.push(info)
            }
          } catch (err) { errors.push(`${file.name}: ${err.response?.data?.detail || err.message}`) }
        }
        if (errors.length) {
          setDropStatus({ error: errors.join('; ') })
          setTimeout(() => setDropStatus(null), 5000)
          return
        }
        if (incompatible.length > 0) {
          setDropTrackMismatch({ tracks: incompatible })
        }
      }

      if (unknownFiles.length) {
        setDropStatus({ error: `Skipped unsupported: ${unknownFiles.map(f => f.name).join(', ')}` })
        setTimeout(() => setDropStatus(null), 4000)
      } else {
        setDropStatus({ msg: 'Files loaded' })
        setTimeout(() => setDropStatus(null), 2000)
      }
    } catch (err) {
      setDropStatus({ error: err.message || 'Drop failed' })
      setTimeout(() => setDropStatus(null), 5000)
    }
  }, [genome, setGenome, navigateTo, addTrack, addGenomeAnnotationTrack])

  const onDropPromptChromosome = useCallback(async () => {
    if (!dropPrompt) return
    const files = dropPrompt.files
    setDropPrompt(null)
    try {
      const errors = []
      for (const file of files) {
        setDropStatus({ msg: `Adding chromosomes from ${file.name}...` })
        try {
          const res = await genomeApi.addChromosomes(file)
          const info = res.data
          if (info.name) info.name = cleanName(info.name)
          setGenome(info)
          // Ensure annotation track exists when the merged genome has annotations
          if (info.is_annotated) {
            addGenomeAnnotationTrack({
              id: 'genome_annotations', name: `${info.name} (annotations)`,
              track_type: 'genome_annotations', file_format: 'genbank',
              targetChromosomes: info.annotated_chromosomes || null,
            })
          }
        } catch (err) { errors.push(`${file.name}: ${err.response?.data?.detail || err.message}`) }
      }
      if (errors.length) {
        setDropStatus({ error: errors.join('; ') })
        setTimeout(() => setDropStatus(null), 5000)
      } else {
        setDropStatus({ msg: `Added chromosomes from ${files.length} file${files.length > 1 ? 's' : ''}` })
        setTimeout(() => setDropStatus(null), 3000)
      }
    } catch (err) {
      setDropStatus({ error: err.message || 'Failed to add chromosomes' })
      setTimeout(() => setDropStatus(null), 5000)
    }
  }, [dropPrompt, setGenome, addGenomeAnnotationTrack])

  const onDropPromptTrack = useCallback(async () => {
    if (!dropPrompt) return
    const files = dropPrompt.files
    setDropPrompt(null)
    try {
      setDropStatus({ msg: `Loading ${files.length} track${files.length > 1 ? 's' : ''}...` })
      const errors = []
      for (const file of files) {
        try { await addTrack(file, undefined) }
        catch (err) { errors.push(`${file.name}: ${err.response?.data?.detail || err.message}`) }
      }
      if (errors.length) {
        setDropStatus({ error: errors.join('; ') })
        setTimeout(() => setDropStatus(null), 5000)
      } else {
        setDropStatus({ msg: `Added ${files.length} track${files.length > 1 ? 's' : ''}` })
        setTimeout(() => setDropStatus(null), 3000)
      }
    } catch (err) {
      setDropStatus({ error: err.message || 'Failed to load tracks' })
      setTimeout(() => setDropStatus(null), 5000)
    }
  }, [dropPrompt, addTrack])

  const onDropMismatchSkip = useCallback(async () => {
    if (!dropTrackMismatch) return
    for (const t of dropTrackMismatch.tracks) await discardTrack(t.id)
    setDropTrackMismatch(null)
  }, [dropTrackMismatch, discardTrack])

  const onDropMismatchLoad = useCallback(() => {
    if (!dropTrackMismatch) return
    for (const t of dropTrackMismatch.tracks) commitTrack(t)
    setDropTrackMismatch(null)
    setDropStatus({ msg: `Added ${dropTrackMismatch.tracks.length} track${dropTrackMismatch.tracks.length > 1 ? 's' : ''}` })
    setTimeout(() => setDropStatus(null), 3000)
  }, [dropTrackMismatch, commitTrack])

  const onLabelResizeStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = labelWidth
    function onMove(ev) {
      setLabelWidth(Math.max(60, Math.min(400, startW + (ev.clientX - startX))))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [labelWidth])

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(entries => {
      for (const e of entries) setContainerWidth(e.contentRect.width)
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  /** A track is shown if it is user-visible AND has data for the current chromosome. */
  const isTrackActive = useCallback((t) => {
    if (!t.visible) return false
    if (!t.targetChromosomes || !region?.chrom) return true
    return t.targetChromosomes.includes(region.chrom)
  }, [region?.chrom])

  const S = {
    app: { display: 'flex', flexDirection: 'column', height: '100vh', background: theme.appBg, color: theme.textPrimary },
    header: {
      background: theme.headerBg, borderBottom: `2px solid ${theme.borderAccent}`, padding: '8px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    },
    headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
    title: { fontSize: 18, fontWeight: 700, color: theme.textPrimary, letterSpacing: 1 },
    subtitle: { fontSize: 11, color: theme.textTertiary },
    headerBtns: { display: 'flex', gap: 8 },
    btn: {
      background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
      color: theme.btnText, padding: '5px 14px', cursor: 'pointer', fontSize: 12,
      fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
    },
    trackArea: { flex: 1, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' },
    emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: theme.textMuted, gap: 12 },
    emptyTitle: { fontSize: 22, fontWeight: 300 },
    emptyHint: { fontSize: 13 },
  }

  return (
    <div
      style={S.app}
      onDragEnter={onAppDragEnter}
      onDragLeave={onAppDragLeave}
      onDragOver={onAppDragOver}
      onDrop={onAppDrop}
    >
      <div style={S.header}>
        <div style={S.headerLeft}>
          <BingoLogo size={34} />
          <div>
            <div style={S.title}>BiNgo Genome Viewer</div>
            {genome && <div style={S.subtitle}>{genome.name} · {genome.chromosomes.length} chr</div>}
          </div>
          <button
            onClick={() => setShowAbout(true)}
            title="About"
            style={{
              background: 'none', border: `1px solid ${theme.border}`, borderRadius: '50%',
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: theme.textSecondary, fontSize: 12, fontWeight: 700,
              lineHeight: 1, padding: 0, flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = theme.textPrimary; e.currentTarget.style.borderColor = theme.textSecondary }}
            onMouseLeave={e => { e.currentTarget.style.color = theme.textSecondary; e.currentTarget.style.borderColor = theme.border }}
          >?</button>
          <button
            onClick={() => setShowTour(true)}
            title="Guided Tour"
            style={{
              background: 'none', border: `1px solid ${theme.border}`, borderRadius: 10,
              padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 4,
              cursor: 'pointer', color: theme.textSecondary, fontSize: 11, fontWeight: 600,
              lineHeight: 1, flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = theme.textPrimary; e.currentTarget.style.borderColor = theme.textSecondary }}
            onMouseLeave={e => { e.currentTarget.style.color = theme.textSecondary; e.currentTarget.style.borderColor = theme.border }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zM8 13.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
            </svg>
            Help
          </button>
        </div>
        <div style={S.headerBtns} data-tour="header-btns">
          <button style={S.btn} onClick={() => setShowSession(true)} title="Save or restore a session">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M2 2h8v8H2z"/><path d="M4 2v4h4V2"/><path d="M5 3h2"/>
            </svg>
            Save Session
          </button>
          <button style={S.btn} onClick={() => setShowTheme(true)} title="Customize color theme">
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
              <rect x="0" y="0" width="5.5" height="5.5" rx="1" fill="#66bb6a"/>
              <rect x="6.5" y="0" width="5.5" height="5.5" rx="1" fill="#42a5f5"/>
              <rect x="0" y="6.5" width="5.5" height="5.5" rx="1" fill="#ffa726"/>
              <rect x="6.5" y="6.5" width="5.5" height="5.5" rx="1" fill="#ab47bc"/>
            </svg>
            Theme
          </button>
          <button
            data-tour="btn-export"
            style={{ ...S.btn, ...(!(region && tracks.length > 0) ? { opacity: 0.35, cursor: 'default' } : {}) }}
            onClick={() => { if (region && tracks.length > 0) setShowExport(true) }}
            title="Export current view as SVG or PNG"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M6 1v7M3 5.5L6 8.5 9 5.5M2 11h8"/>
            </svg>
            Export Image
          </button>
          <button
            data-tour="btn-settings"
            style={{ ...S.btn, ...(tracks.length === 0 ? { opacity: 0.35, cursor: 'default' } : {}) }}
            onClick={() => { if (tracks.length > 0) setShowSettings(true) }}
            title="Adjust height, scale, color, and bar width for tracks"
          >
            {'\u2699'} Track Settings
          </button>
        </div>
      </div>

      <FileLoader />
      <NavigationBar />

      <div style={S.trackArea} ref={containerRef} data-tour="track-area">
        {/* Skeleton track — always visible when no real tracks are loaded */}
        {tracks.filter(isTrackActive).length === 0 && (
          <SkeletonTrack theme={theme} labelWidth={labelWidth} />
        )}

        {!genome ? (
          <div style={S.emptyState}>
            <div style={S.emptyTitle}>No genome loaded</div>
            <div style={S.emptyHint}>Load a FASTA or GenBank file above to get started</div>
          </div>
        ) : !region ? (
          <div style={S.emptyState}>
            <div style={S.emptyHint}>Select a chromosome to begin</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex' }}>
              <div style={{
                width: labelWidth, minWidth: labelWidth, background: theme.panelBg,
                borderRight: `1px solid ${theme.border}`, position: 'relative',
              }}>
                <div
                  onMouseDown={onLabelResizeStart}
                  style={{
                    position: 'absolute', right: -3, top: 0, bottom: 0, width: 6,
                    cursor: 'ew-resize', zIndex: 10,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                />
              </div>
              <RulerTrack width={containerWidth - labelWidth} />
            </div>
            {tracks.filter(isTrackActive).map(track => (
              <TrackPanel
                key={track.id}
                track={track}
                containerWidth={containerWidth}
                labelWidth={labelWidth}
                onLabelResizeStart={onLabelResizeStart}
                isDragging={dragTrackId === track.id}
                isDropTarget={dropTrackId === track.id}
                onDragStart={() => setDragTrackId(track.id)}
                onDragOver={() => setDropTrackId(track.id)}
                onDrop={() => {
                  if (dragTrackId && dragTrackId !== track.id) {
                    reorderTracks(dragTrackId, track.id)
                  }
                  setDragTrackId(null)
                  setDropTrackId(null)
                }}
                onDragEnd={() => { setDragTrackId(null); setDropTrackId(null) }}
              />
            ))}
            {tracks.length === 0 && (
              <div style={{ padding: 24, color: theme.textMuted, fontSize: 13 }}>
                Add tracks above — BAM, VCF, BigWig, BED, GTF, GFF, WIG...
              </div>
            )}
          </>
        )}
      </div>

      {showSettings && <TrackSettings onClose={() => setShowSettings(false)} />}
      {showTheme && <ThemeSettings onClose={() => setShowTheme(false)} />}
      {showExport && <ExportImage onClose={() => setShowExport(false)} />}
      {showSession && <SessionManager onClose={() => setShowSession(false)} labelWidth={labelWidth} setLabelWidth={setLabelWidth} />}
      {showTour && <HelpTour onClose={() => setShowTour(false)} theme={theme} />}

      {showAbout && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }} onClick={() => setShowAbout(false)}>
          <div style={{
            background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8,
            padding: '28px 36px', maxWidth: 400, color: theme.textPrimary, lineHeight: 1.7,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <BingoLogo size={44} />
              <div style={{ fontSize: 20, fontWeight: 700 }}>BiNgo Genome Viewer</div>
            </div>
            <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 12 }}>
              <strong style={{ color: theme.textPrimary }}>Version:</strong> {APP_VERSION}
            </div>
            <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 12 }}>
              <strong style={{ color: theme.textPrimary }}>Publisher:</strong> Billy Ngo
            </div>
            <div style={{ fontSize: 13, color: theme.textSecondary, marginBottom: 20 }}>
              <strong style={{ color: theme.textPrimary }}>Published:</strong> April 2026
            </div>
            <div style={{
              fontSize: 12, color: theme.textSecondary, background: theme.canvasBg,
              border: `1px solid ${theme.border}`, borderRadius: 4, padding: '10px 14px',
              fontFamily: 'monospace', lineHeight: 1.6, marginBottom: 20, userSelect: 'all',
            }}>
              Ngo, B. (2026). BiNgo Genome Viewer (v{APP_VERSION}) [Software].
            </div>
            <div style={{ textAlign: 'right' }}>
              <button
                onClick={() => setShowAbout(false)}
                style={{
                  background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                  color: theme.btnText, padding: '5px 18px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}
              >Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt when genome file dropped while genome already loaded */}
      {dropPrompt && (() => {
        const plural = dropPrompt.files.length > 1
        const names = dropPrompt.files.map(f => f.name).join(', ')
        return (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          }}>
            <div style={{
              background: theme.panelBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 8,
              padding: '20px 24px', maxWidth: 440, width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 14, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
                Genome file{plural ? 's' : ''} detected
              </div>
              <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
                <strong style={{ color: theme.textPrimary }}>{names}</strong>
                {plural
                  ? ' appear to be genome files. A genome is already loaded.'
                  : ' appears to be a genome file. A genome is already loaded.'}
                <br />How would you like to handle {plural ? 'them' : 'it'}?
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setDropPrompt(null)}
                  style={{
                    background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                    color: theme.btnText, padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}
                >Skip</button>
                <button
                  onClick={onDropPromptTrack}
                  style={{
                    background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                    color: theme.btnText, padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}
                >Add as Track{plural ? 's' : ''}</button>
                <button
                  onClick={onDropPromptChromosome}
                  style={{
                    background: '#1976d2', border: 'none', borderRadius: 4,
                    color: '#fff', padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}
                >Add as Chromosome{plural ? 's' : ''}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Track-genome compatibility mismatch prompt (drag-drop) */}
      {dropTrackMismatch && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 8,
            padding: '20px 24px', maxWidth: 480, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 }}>
              Track compatibility warning
            </div>
            <div style={{ fontSize: 12, color: theme.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
              {dropTrackMismatch.tracks.map(t => (
                <div key={t.id} style={{ marginBottom: 6 }}>
                  <strong style={{ color: theme.textPrimary }}>{t.name}</strong>
                  {' \u2014 '}{t.compatibility?.message || 'Possible mismatch with loaded genome'}
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                {dropTrackMismatch.tracks.length > 1
                  ? 'These tracks may not match the loaded genome.'
                  : 'This track may not match the loaded genome.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={onDropMismatchSkip}
                style={{
                  background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
                  color: theme.btnText, padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}
              >Skip</button>
              <button
                onClick={onDropMismatchLoad}
                style={{
                  background: '#1976d2', border: 'none', borderRadius: 4,
                  color: '#fff', padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}
              >Load Anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen drop overlay */}
      {appDragOver && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            border: `3px dashed ${theme.textSecondary}`, borderRadius: 16,
            padding: '40px 60px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 28, fontWeight: 300, color: theme.textPrimary, marginBottom: 8 }}>
              Drop files here
            </div>
            <div style={{ fontSize: 13, color: theme.textSecondary }}>
              Genome (.gb, .fasta) or track files (.bam, .bw, .wig, .vcf, .bed, .gff, .gtf)
            </div>
          </div>
        </div>
      )}

      {/* Drop status toast */}
      {dropStatus && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10001, padding: '8px 20px', borderRadius: 6,
          background: dropStatus.error ? '#c62828' : theme.panelBg,
          border: `1px solid ${dropStatus.error ? '#e53935' : theme.borderAccent}`,
          color: dropStatus.error ? '#fff' : '#81c784',
          fontSize: 12, fontWeight: 600,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          {dropStatus.error || dropStatus.msg}
        </div>
      )}

      {/* Exit warning guard */}
      {genome && <ExitGuard labelWidth={labelWidth} />}
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserProvider>
        <TrackProvider>
          <BrowserApp />
        </TrackProvider>
      </BrowserProvider>
    </ThemeProvider>
  )
}
