/**
 * NavigationBar.jsx — Chromosome selector, coordinate input, and zoom/pan buttons.
 *
 * Sits below the header; lets users jump to a region by typing coordinates
 * or using the zoom/pan controls.
 */
import React, { useState, useEffect, useMemo } from 'react'
import { useBrowser } from '../store/BrowserContext'
import { useTheme } from '../store/ThemeContext'

export default function NavigationBar() {
  const { theme } = useTheme()
  const { genome, region, navigateTo, zoom, pan } = useBrowser()
  const [coordText, setCoordText] = useState('')

  // Build short label map: full name → "chr1", "chr2", etc.
  const chromMap = useMemo(() => {
    if (!genome) return { toShort: {}, toLong: {} }
    const toShort = {}
    const toLong = {}
    genome.chromosomes.forEach((c, i) => {
      const short = `chr${i + 1}`
      toShort[c.name] = short
      toLong[short.toLowerCase()] = c.name
      // Also allow the full name as-is
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

  const S = {
    bar: { background: theme.headerBg, borderBottom: `1px solid ${theme.border}`, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    select: { background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4, color: theme.textPrimary, padding: '4px 6px', fontSize: 12 },
    coordInput: { background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4, color: theme.textPrimary, padding: '4px 8px', fontSize: 12, width: 220, fontFamily: 'monospace' },
    btn: { background: theme.btnBg, border: 'none', borderRadius: 4, color: theme.btnText, padding: '4px 10px', cursor: 'pointer', fontSize: 13 },
    info: { color: theme.textSecondary, fontSize: 11, marginLeft: 8 },
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
      // Resolve short label (chr1) or full name to actual chromosome name
      const resolved = chromMap.toLong[m[1].toLowerCase()] || m[1]
      navigateTo(resolved, parseInt(m[2]), parseInt(m[3]))
    }
  }

  if (!genome) return null
  const regionLen = region ? region.end - region.start : 0

  return (
    <div style={S.bar}>
      <select style={S.select} value={region?.chrom || ''} onChange={handleChromChange}>
        {genome.chromosomes.map((c, i) => (
          <option key={c.name} value={c.name}>
            chr{i + 1} \u2014 {c.name} ({(c.length / 1000).toFixed(0)} kbp)
          </option>
        ))}
      </select>
      <form onSubmit={handleCoordSubmit} style={{ display: 'flex', gap: 4 }}>
        <input style={S.coordInput} value={coordText} onChange={e => setCoordText(e.target.value)} placeholder="chr1:start-end" />
        <button style={S.btn} type="submit">Go</button>
      </form>
      <button style={S.btn} onClick={() => zoom(0.5)} title="Zoom in">{'\uFF0B'}</button>
      <button style={S.btn} onClick={() => zoom(2)} title="Zoom out">{'\uFF0D'}</button>
      <button style={S.btn} onClick={() => pan(-regionLen * 0.5)} title="Pan left">{'\u25C0'}</button>
      <button style={S.btn} onClick={() => pan(regionLen * 0.5)} title="Pan right">{'\u25B6'}</button>
      {region && (
        <span style={S.info}>
          {regionLen.toLocaleString()} bp
          {regionLen > 1_000_000 ? ` (${(regionLen / 1_000_000).toFixed(2)} Mbp)` : ''}
        </span>
      )}
    </div>
  )
}
