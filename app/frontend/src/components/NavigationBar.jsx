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

export default function NavigationBar() {
  const { theme } = useTheme()
  const { genome, region, navigateTo, zoom, pan } = useBrowser()
  const [coordText, setCoordText] = useState('')
  const scrubberRef = useRef(null)
  const draggingRef = useRef(false)

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
