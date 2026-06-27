/**
 * NavigationBar.jsx — Chromosome selector, coordinate input, zoom/pan buttons,
 * and a full-chromosome scrubber slider.
 *
 * The scrubber shows the current viewport position within the chromosome and
 * allows click-drag to scroll rapidly across the entire chromosome.
 */
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useBrowser } from '../store/BrowserContext'
import { useTheme } from '../store/ThemeContext'
import { genomeApi } from '../api/client'

export default function NavigationBar() {
  const { theme } = useTheme()
  const { genome, region, selection, navigateTo, zoom, pan, setSelection } = useBrowser()
  const [coordText, setCoordText] = useState('')
  const scrubberRef = useRef(null)
  const draggingRef = useRef(false)

  // ── Gene/feature search ────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef(null)
  const searchAbortRef = useRef(null)
  const searchDebounceRef = useRef(null)
  const searchContainerRef = useRef(null)

  // Close the search popover on an outside click
  useEffect(() => {
    if (!searchOpen) return
    function onDocMouseDown(e) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [searchOpen])

  // Debounced query → backend search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    const q = query.trim()
    if (!q) { setResults([]); setSearching(false); return }
    setSearching(true)
    searchDebounceRef.current = setTimeout(async () => {
      if (searchAbortRef.current) searchAbortRef.current.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller
      try {
        const res = await genomeApi.search(q, 30, { signal: controller.signal })
        setResults(res.data.results || [])
        setActiveIdx(0)
      } catch (e) {
        if (e.name !== 'CanceledError' && e.code !== 'ERR_CANCELED') setResults([])
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 220)
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current) }
  }, [query])

  // Focus the input when the search opens
  useEffect(() => {
    if (searchOpen && searchInputRef.current) searchInputRef.current.focus()
  }, [searchOpen])

  const goToFeature = useCallback((feat) => {
    if (!feat) return
    const featLen = Math.max(1, feat.end - feat.start)
    const context = featLen * 0.4   // ~70% of the view is the feature
    navigateTo(feat.chrom, feat.start - context, feat.end + context)
    if (setSelection) setSelection({ chrom: feat.chrom, start: feat.start, end: feat.end })
    setSearchOpen(false)
    setQuery('')
    setResults([])
  }, [navigateTo, setSelection])

  const onSearchKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(results.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[activeIdx]) goToFeature(results[activeIdx]) }
    else if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); setQuery(''); setResults([]) }
  }, [results, activeIdx, goToFeature])

  // Build short label map: full name → "chr1", "chr2", etc.
  const chromMap = useMemo(() => {
    if (!genome) return { toShort: {}, toLong: {} }
    const toShort = {}
    const toLong = {}
    genome.chromosomes.forEach((c, i) => {
      const short = `chr${i + 1}`
      toShort[c.name] = short
      toLong[short.toLowerCase()] = c.name
      toLong[c.name.toLowerCase()] = c.name
    })
    return { toShort, toLong }
  }, [genome])

  useEffect(() => {
    if (region) {
      const short = chromMap.toShort[region.chrom] || region.chrom
      setCoordText(`${short}:${region.start.toLocaleString()}-${region.end.toLocaleString()}`)
    }
  }, [region, chromMap])

  // ── Scrubber drag logic ────────────────────────────────────────
  const chromLen = useMemo(() => {
    if (!genome || !region) return 0
    const chr = genome.chromosomes.find(c => c.name === region.chrom)
    return chr ? chr.length : 0
  }, [genome, region?.chrom])

  const scrubToPosition = useCallback((clientX) => {
    if (!scrubberRef.current || !region || !chromLen) return
    const rect = scrubberRef.current.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const viewLen = region.end - region.start
    const center = frac * chromLen
    navigateTo(region.chrom, center - viewLen / 2, center + viewLen / 2)
  }, [region, chromLen, navigateTo])

  const onScrubberMouseDown = useCallback((e) => {
    e.preventDefault()
    draggingRef.current = true
    scrubToPosition(e.clientX)

    function onMove(ev) {
      if (draggingRef.current) scrubToPosition(ev.clientX)
    }
    function onUp() {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [scrubToPosition])

  const S = {
    bar: { background: theme.headerBg, borderBottom: `1px solid ${theme.border}`, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    select: { background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4, color: theme.textPrimary, padding: '4px 6px', fontSize: 12 },
    coordInput: { background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4, color: theme.textPrimary, padding: '4px 8px', fontSize: 12, width: 220, fontFamily: 'monospace' },
    btn: { background: theme.btnBg, border: 'none', borderRadius: 4, color: theme.btnText, padding: '4px 10px', cursor: 'pointer', fontSize: 13 },
    info: { color: theme.textSecondary, fontSize: 11, marginLeft: 8 },
    scrubberWrap: {
      flex: 1, minWidth: 120, height: 14, position: 'relative',
      background: theme.inputBg, borderRadius: 7,
      border: `1px solid ${theme.borderAccent}`, cursor: 'pointer',
      overflow: 'hidden',
    },
  }

  function handleChromChange(e) {
    if (!genome) return
    const chr = genome.chromosomes.find(c => c.name === e.target.value)
    if (chr) navigateTo(chr.name, 0, Math.min(chr.length, 50000))
  }

  function handleCoordSubmit(e) {
    e.preventDefault()
    const clean = coordText.replace(/,/g, '').trim()
    const m = clean.match(/^(\S+):(\d+)-(\d+)$/)
    if (m) {
      const resolved = chromMap.toLong[m[1].toLowerCase()] || m[1]
      navigateTo(resolved, parseInt(m[2]), parseInt(m[3]))
    }
  }

  if (!genome) return (
    <div style={{ ...S.bar, opacity: 0.4 }} data-tour="nav-bar">
      <span style={{ fontSize: 12, color: theme.textMuted, fontStyle: 'italic' }}>Load a genome to enable navigation</span>
    </div>
  )

  const regionLen = region ? region.end - region.start : 0

  // Scrubber thumb position and width
  let thumbLeft = 0, thumbWidth = 100
  if (region && chromLen > 0) {
    thumbLeft = (region.start / chromLen) * 100
    thumbWidth = Math.max(1, (regionLen / chromLen) * 100)
  }

  return (
    <div style={S.bar} data-tour="nav-bar">
      <select style={S.select} value={region?.chrom || ''} onChange={handleChromChange}>
        {genome.chromosomes.map((c, i) => (
          <option key={c.name} value={c.name}>
            chr{i + 1} {'\u2014'} {c.name} ({(c.length / 1000).toFixed(0)} kbp)
          </option>
        ))}
      </select>
      <form onSubmit={handleCoordSubmit} style={{ display: 'flex', gap: 4 }}>
        <input style={S.coordInput} value={coordText} onChange={e => setCoordText(e.target.value)} placeholder="chr1:start-end" />
        <button style={S.btn} type="submit">Go</button>
      </form>
      <button style={S.btn} onClick={() => zoom(2)} title="Zoom out">{'\uFF0D'}</button>
      <button style={S.btn} onClick={() => zoom(0.5)} title="Zoom in">{'\uFF0B'}</button>
      <button style={S.btn} onClick={() => pan(-regionLen * 0.5)} title="Pan left">{'\u25C0'}</button>
      <button style={S.btn} onClick={() => pan(regionLen * 0.5)} title="Pan right">{'\u25B6'}</button>
      <button
        style={{ ...S.btn, opacity: selection ? 1 : 0.3, cursor: selection ? 'pointer' : 'default' }}
        onClick={() => {
          if (selection && region) {
            const selLen = selection.end - selection.start
            const context = selLen * 0.15
            navigateTo(selection.chrom, selection.start - context, selection.end + context)
          }
        }}
        disabled={!selection}
        title={selection ? `Snap to selection (${selection.start.toLocaleString()}-${selection.end.toLocaleString()})` : 'No region selected (right-click drag to select)'}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ display: 'block' }}>
          <circle cx="6" cy="6" r="4" />
          <line x1="6" y1="0" x2="6" y2="3" />
          <line x1="6" y1="9" x2="6" y2="12" />
          <line x1="0" y1="6" x2="3" y2="6" />
          <line x1="9" y1="6" x2="12" y2="6" />
        </svg>
      </button>

      {/* Gene / feature search */}
      <div ref={searchContainerRef} style={{ position: 'relative', display: 'flex' }}>
        <button
          style={{ ...S.btn, display: 'flex', alignItems: 'center', justifyContent: 'center', background: searchOpen ? theme.btnActive || theme.borderAccent : theme.btnBg }}
          onClick={() => setSearchOpen(o => !o)}
          title="Search genes / features (name, locus_tag, product, peak)"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ display: 'block' }}>
            <circle cx="6.8" cy="6.8" r="4.5" />
            <line x1="10.4" y1="10.4" x2="15" y2="15" />
          </svg>
        </button>
        {searchOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 1200,
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
            borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.5)', width: 320,
            overflow: 'hidden',
          }}>
            <input
              ref={searchInputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Gene, locus_tag, product, peak rank…"
              style={{
                width: '100%', boxSizing: 'border-box', border: 'none',
                borderBottom: `1px solid ${theme.border}`, background: theme.inputBg,
                color: theme.textPrimary, padding: '8px 10px', fontSize: 13, outline: 'none',
              }}
            />
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {query.trim() && !searching && results.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 12, color: theme.textTertiary }}>No matches</div>
              )}
              {searching && results.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 12, color: theme.textTertiary }}>Searching…</div>
              )}
              {results.map((r, i) => {
                const shortChrom = chromMap.toShort[r.chrom] || r.chrom
                return (
                  <div
                    key={`${r.chrom}:${r.start}-${r.end}:${r.name}:${i}`}
                    onMouseDown={(e) => { e.preventDefault(); goToFeature(r) }}
                    onMouseEnter={() => setActiveIdx(i)}
                    style={{
                      padding: '6px 10px', cursor: 'pointer', fontSize: 12,
                      background: i === activeIdx ? (theme.selectedRow || 'rgba(255,255,255,0.08)') : 'transparent',
                      borderBottom: `1px solid ${theme.border}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: theme.textPrimary, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                      <span style={{ color: theme.textTertiary, flexShrink: 0, fontSize: 10 }}>{r.feature_type}</span>
                    </div>
                    <div style={{ color: theme.textSecondary, fontSize: 10, marginTop: 1, fontFamily: 'monospace' }}>
                      {shortChrom}:{r.start.toLocaleString()}-{r.end.toLocaleString()}
                      {r.source && r.source !== 'genome' && <span style={{ color: theme.textTertiary }}> · {r.source}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Chromosome scrubber */}
      {region && chromLen > 0 && (
        <div
          ref={scrubberRef}
          style={S.scrubberWrap}
          onMouseDown={onScrubberMouseDown}
          title="Drag to scroll across the chromosome"
        >
          <div style={{
            position: 'absolute',
            left: `${thumbLeft}%`,
            width: `${thumbWidth}%`,
            top: 1, bottom: 1,
            background: '#42a5f5',
            borderRadius: 6,
            minWidth: 8,
            opacity: 0.7,
            transition: draggingRef.current ? 'none' : 'left 0.1s ease',
          }} />
        </div>
      )}

      {region && (
        <span style={S.info}>
          {regionLen.toLocaleString()} bp
        </span>
      )}
    </div>
  )
}
