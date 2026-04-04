/**
 * App.jsx — Root component and layout shell.
 *
 * Provides context providers (Browser, Track, Theme), renders the header
 * toolbar, navigation bar, ruler, track panels, and all modal dialogs.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react'
import { BrowserProvider, useBrowser } from './store/BrowserContext'
import { TrackProvider, useTracks } from './store/TrackContext'
import { ThemeProvider, useTheme } from './store/ThemeContext'
import FileLoader from './components/ui/FileLoader'
import TrackSettings from './components/ui/TrackSettings'
import ThemeSettings from './components/ui/ThemeSettings'
import ExportImage from './components/ui/ExportImage'
import SessionManager, { useAutoSave } from './components/ui/SessionManager'
import NavigationBar from './components/NavigationBar'
import RulerTrack from './components/RulerTrack'
import TrackPanel from './components/TrackPanel'

const APP_VERSION = '1.0.0'

function BrowserApp() {
  const { theme } = useTheme()
  const { genome, region } = useBrowser()
  const { tracks, reorderTracks } = useTracks()
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [showSettings, setShowSettings] = useState(false)
  const [showTheme, setShowTheme] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSession, setShowSession] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [labelWidth, setLabelWidth] = useState(140)
  const [dragTrackId, setDragTrackId] = useState(null)
  const [dropTrackId, setDropTrackId] = useState(null)

  useAutoSave(labelWidth)

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
    trackArea: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
    emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: theme.textMuted, gap: 12 },
    emptyTitle: { fontSize: 22, fontWeight: 300 },
    emptyHint: { fontSize: 13 },
  }

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={S.headerLeft}>
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
        </div>
        <div style={S.headerBtns}>
          <button style={S.btn} onClick={() => setShowSession(true)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M2 2h8v8H2z"/><path d="M4 2v4h4V2"/><path d="M5 3h2"/>
            </svg>
            Save Session
          </button>
          <button style={S.btn} onClick={() => setShowTheme(true)}>
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
              <rect x="0" y="0" width="5.5" height="5.5" rx="1" fill="#66bb6a"/>
              <rect x="6.5" y="0" width="5.5" height="5.5" rx="1" fill="#42a5f5"/>
              <rect x="0" y="6.5" width="5.5" height="5.5" rx="1" fill="#ffa726"/>
              <rect x="6.5" y="6.5" width="5.5" height="5.5" rx="1" fill="#ab47bc"/>
            </svg>
            Theme
          </button>
          {region && tracks.length > 0 && (
            <button style={S.btn} onClick={() => setShowExport(true)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M6 1v7M3 5.5L6 8.5 9 5.5M2 11h8"/>
              </svg>
              Export
            </button>
          )}
          {tracks.length > 0 && (
            <button style={S.btn} onClick={() => setShowSettings(true)}>
              {'\u2699'} Track Settings
            </button>
          )}
        </div>
      </div>

      <FileLoader />
      <NavigationBar />

      <div style={S.trackArea} ref={containerRef}>
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
            {tracks.filter(t => t.visible).map(track => (
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

      {showAbout && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }} onClick={() => setShowAbout(false)}>
          <div style={{
            background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8,
            padding: '28px 36px', maxWidth: 400, color: theme.textPrimary, lineHeight: 1.7,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>BiNgo Genome Viewer</div>
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
