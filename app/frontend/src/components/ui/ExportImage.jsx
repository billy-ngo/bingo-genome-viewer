/**
 * ExportImage.jsx — Export the current view as SVG or PNG.
 *
 * Renders all visible tracks to an SVG document matching the on-screen layout,
 * then offers download. Supports coverage bars, annotations, reads, and variants.
 */
import React, { useState } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import { getLiveTrackData } from '../../hooks/useTrackData'

const FORMATS = ['svg', 'png', 'jpg']
const LABEL_W = 140

export default function ExportImage({ onClose }) {
  const { region } = useBrowser()
  const { tracks } = useTracks()
  const { theme } = useTheme()
  const chrom = region?.chrom
  const visibleTracks = tracks.filter(t =>
    t.visible && (!t.targetChromosomes || !chrom || t.targetChromosomes.includes(chrom))
  )

  const [format, setFormat] = useState('svg')
  const [includeRuler, setIncludeRuler] = useState(true)
  const [includeLabels, setIncludeLabels] = useState(true)
  const [selectedTrackIds, setSelectedTrackIds] = useState(new Set(visibleTracks.map(t => t.id)))
  const [exportWidth, setExportWidth] = useState(1200)
  const [exporting, setExporting] = useState(false)

  function toggleTrack(id) {
    setSelectedTrackIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function doExport() {
    if (!region) return
    setExporting(true)
    try {
      const selectedTracks = visibleTracks.filter(t => selectedTrackIds.has(t.id))
      const labelW = includeLabels ? LABEL_W : 0
      const trackW = exportWidth - labelW
      const rulerH = includeRuler ? 30 : 0
      const totalH = rulerH + selectedTracks.reduce((sum, t) => sum + t.height, 0)

      if (format === 'svg') {
        const svg = buildSVG(region, selectedTracks, theme, trackW, labelW, rulerH, totalH, includeRuler, includeLabels)
        download(svg, 'genomics-export.svg', 'image/svg+xml')
      } else {
        const canvas = buildCanvas(region, selectedTracks, theme, trackW, labelW, rulerH, totalH, exportWidth, includeRuler, includeLabels)
        const mime = format === 'png' ? 'image/png' : 'image/jpeg'
        canvas.toBlob(blob => {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = `genomics-export.${format}`; a.click()
          URL.revokeObjectURL(url)
        }, mime, 0.95)
      }
    } finally { setExporting(false) }
  }

  const S = makeStyles(theme)

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.title}>Export Image</span>
          <button style={S.closeBtn} onClick={onClose}>{'\u2715'}</button>
        </div>
        <div style={S.body}>
          {/* Format */}
          <div style={S.row}>
            <span style={S.label}>Format</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {FORMATS.map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  style={{ ...S.fmtBtn, border: format === f ? `2px solid ${theme.textPrimary}` : `1px solid ${theme.borderAccent}` }}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {/* Width */}
          <div style={S.row}>
            <span style={S.label}>Width (px)</span>
            <input type="number" min={400} max={4000} step={100} value={exportWidth}
              onChange={e => setExportWidth(Math.max(400, parseInt(e.target.value) || 1200))} style={S.input} />
          </div>
          {/* Options */}
          <div style={S.row}>
            <label style={S.cb}><input type="checkbox" checked={includeRuler} onChange={e => setIncludeRuler(e.target.checked)} /> Ruler</label>
            <label style={S.cb}><input type="checkbox" checked={includeLabels} onChange={e => setIncludeLabels(e.target.checked)} /> Track labels</label>
          </div>
          {/* Track selection */}
          <div style={{ ...S.row, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <span style={S.label}>Include tracks</span>
            {visibleTracks.map(t => (
              <label key={t.id} style={{ ...S.cb, gap: 6 }}>
                <input type="checkbox" checked={selectedTrackIds.has(t.id)} onChange={() => toggleTrack(t.id)} />
                <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
                <span style={{ fontSize: 11 }}>{t.name}</span>
              </label>
            ))}
          </div>
          {format === 'svg' && (
            <div style={{ padding: '4px 0', fontSize: 10, color: theme.textTertiary }}>
              SVG output is fully vectorized — editable in Illustrator, Inkscape, etc.
            </div>
          )}
        </div>
        <div style={S.footer}>
          <button style={S.btn} onClick={doExport} disabled={exporting || !region}>
            {exporting ? 'Exporting\u2026' : `Export ${format.toUpperCase()}`}
          </button>
          <button style={{ ...S.btn, background: theme.borderAccent }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ─── SVG Builder ────────────────────────────────────────────────────────────

function buildSVG(region, tracks, theme, trackW, labelW, rulerH, totalH, includeRuler, includeLabels) {
  const w = trackW + labelW
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" font-family="Arial, Helvetica, sans-serif">\n`
  svg += `<defs>\n`
  svg += `  <clipPath id="trackClip"><rect width="${trackW}" height="${totalH}"/></clipPath>\n`
  svg += `</defs>\n`
  svg += `<rect width="${w}" height="${totalH}" fill="${theme.canvasBg}"/>\n`

  let yOff = 0

  if (includeRuler) {
    svg += svgRuler(region, labelW, 0, trackW, 30, theme)
    yOff += rulerH
  }

  for (const track of tracks) {
    const data = getLiveTrackData(track.id)
    // Draw track data first (clipped to track area)
    svg += `<g transform="translate(${labelW},${yOff})" clip-path="url(#trackClip)">\n`
    svg += `<rect width="${trackW}" height="${track.height}" fill="${theme.canvasBg}"/>\n`
    if (track.track_type === 'coverage' || track.track_type === 'reads') {
      svg += svgCoverage(data, region, track, trackW, track.height, theme)
    } else if (track.track_type === 'annotations' || track.track_type === 'genome_annotations') {
      svg += svgAnnotations(data, region, track, trackW, track.height, theme)
    } else if (track.track_type === 'variants') {
      svg += svgVariants(data, region, track, trackW, track.height, theme)
    }
    svg += `</g>\n`
    // Draw labels ON TOP so they are never obscured
    if (includeLabels) {
      svg += `<rect x="0" y="${yOff}" width="${labelW}" height="${track.height}" fill="${theme.panelBg}"/>\n`
      svg += `<line x1="${labelW}" y1="${yOff}" x2="${labelW}" y2="${yOff + track.height}" stroke="${theme.border}"/>\n`
      svg += `<text x="10" y="${yOff + track.height / 2 + 4}" fill="${theme.trackName}" font-size="11" font-weight="600">${esc(track.name)}</text>\n`
    }
    svg += `<line x1="0" y1="${yOff + track.height}" x2="${w}" y2="${yOff + track.height}" stroke="${theme.border}"/>\n`
    yOff += track.height
  }

  svg += `</svg>`
  return svg
}

function svgRuler(region, x0, y0, w, h, theme) {
  let s = `<g transform="translate(${x0},${y0})">\n`
  s += `<rect width="${w}" height="${h}" fill="${theme.canvasBg}"/>\n`
  const { start, end } = region
  const len = end - start
  const targetTicks = Math.min(10, Math.floor(w / 80))
  const rawInterval = len / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rawInterval)))
  const candidates = [1, 2, 5, 10].map(x => x * mag)
  const interval = candidates.find(c => c >= rawInterval) || candidates[candidates.length - 1]
  const firstTick = Math.ceil(start / interval) * interval

  s += `<line x1="0" y1="20" x2="${w}" y2="20" stroke="${theme.rulerTick}" stroke-width="1"/>\n`
  for (let pos = firstTick; pos <= end; pos += interval) {
    const px = ((pos - start) / len) * w
    s += `<line x1="${px}" y1="14" x2="${px}" y2="20" stroke="${theme.rulerTick}" stroke-width="1"/>\n`
    s += `<text x="${px}" y="11" text-anchor="middle" fill="${theme.rulerLabel}" font-size="10" font-family="Arial, Helvetica, sans-serif">${formatBp(pos)}</text>\n`
  }
  s += `</g>\n`
  return s
}

function svgLogScale(val, max) {
  if (val <= 0 || max <= 0) return 0
  return Math.log2(val + 1) / Math.log2(max + 1)
}

function svgCoverage(data, region, track, w, h, theme) {
  if (!data?.bins?.length) return ''
  let s = ''
  const maxVal = data.max_value || 0
  const minVal = data.min_value || 0
  const hasNeg = minVal < 0
  const rStart = region.start, rEnd = region.end
  const regionLen = rEnd - rStart
  const color = track.color || '#78909c'
  const userScaleMax = track.scaleMax
  const userScaleMin = track.scaleMin
  const useLog = track.logScale === true
  // Filter to only bins overlapping the visible region
  const visibleBins = data.bins.filter(b => b.end > rStart && b.start < rEnd)

  const barAuto = track.barAutoWidth !== false
  const barFixedPx = track.barWidth || 2
  const pxPerNt = w / regionLen

  const showBars = track.showBars !== false
  const showOutline = track.showOutline === true
  const outColor = track.outlineColor || null

  function autoW(binW) {
    if (!barAuto) return Math.min(barFixedPx, binW)
    if (pxPerNt >= 1) return Math.max(0.5, Math.min(pxPerNt, binW))
    return Math.max(0.5, binW)
  }

  if (hasNeg) {
    const midY = Math.round(h / 2)
    const topH = midY - 6
    const botH = h - midY - 6
    const posMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
    const negMax = userScaleMin != null ? userScaleMin : (Math.abs(minVal) || 1)
    s += `<line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="${theme.centerLine}" stroke-width="1"/>\n`
    if (showBars) {
      for (const bin of visibleBins) {
        const x = ((bin.start - rStart) / regionLen) * w
        const bw = autoW(((bin.end - bin.start) / regionLen) * w)
        const fwd = bin.forward != null ? bin.forward : Math.max(0, bin.value)
        const rev = bin.reverse != null ? bin.reverse : Math.min(0, bin.value)
        if (fwd > 0) { const r = useLog ? svgLogScale(fwd, posMax) : fwd / posMax; const bh = r * topH; s += `<rect x="${x}" y="${midY - bh}" width="${bw}" height="${bh}" fill="${color}"/>\n` }
        if (rev < 0) { const r = useLog ? svgLogScale(Math.abs(rev), negMax) : Math.abs(rev) / negMax; const bh = r * botH; s += `<rect x="${x}" y="${midY}" width="${bw}" height="${bh}" fill="${adjustColorSvg(color, -40)}"/>\n` }
      }
    }
    if (showOutline && visibleBins.length > 0) {
      // Forward outline
      let pts = visibleBins.map(b => { const x = ((b.start - rStart) / regionLen) * w; const xEnd = ((b.end - rStart) / regionLen) * w; const fwd = b.forward != null ? b.forward : Math.max(0, b.value); const r = fwd > 0 ? (useLog ? svgLogScale(fwd, posMax) : fwd / posMax) : 0; const y = midY - r * topH; return `${x},${y} ${xEnd},${y}` }).join(' ')
      const x0 = ((visibleBins[0].start - rStart) / regionLen) * w
      const xN = ((visibleBins[visibleBins.length - 1].end - rStart) / regionLen) * w
      s += `<polyline points="${x0},${midY} ${pts} ${xN},${midY}" fill="none" stroke="${outColor || color}" stroke-width="1.5"/>\n`
      // Reverse outline
      pts = visibleBins.map(b => { const x = ((b.start - rStart) / regionLen) * w; const xEnd = ((b.end - rStart) / regionLen) * w; const rev = b.reverse != null ? b.reverse : Math.min(0, b.value); const r = rev < 0 ? (useLog ? svgLogScale(Math.abs(rev), negMax) : Math.abs(rev) / negMax) : 0; const y = midY + r * botH; return `${x},${y} ${xEnd},${y}` }).join(' ')
      s += `<polyline points="${x0},${midY} ${pts} ${xN},${midY}" fill="none" stroke="${outColor || adjustColorSvg(color, -40)}" stroke-width="1.5"/>\n`
    }
    const lbl = useLog ? ' log\u2082' : ''
    s += `<text x="2" y="12" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">+${posMax.toFixed(1)}${lbl}</text>\n`
    s += `<text x="2" y="${h - 2}" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">\u2212${negMax.toFixed(1)}${lbl}</text>\n`
  } else {
    const effMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
    if (showBars) {
      for (const bin of visibleBins) {
        const x = ((bin.start - rStart) / regionLen) * w
        const bw = autoW(((bin.end - bin.start) / regionLen) * w)
        const r = useLog ? svgLogScale(bin.value, effMax) : bin.value / effMax
        const bh = r * (h - 14)
        s += `<rect x="${x}" y="${h - bh - 2}" width="${bw}" height="${bh}" fill="${color}"/>\n`
      }
    }
    if (showOutline && visibleBins.length > 0) {
      const baseline = h - 2
      const pts = visibleBins.map(b => { const x = ((b.start - rStart) / regionLen) * w; const xEnd = ((b.end - rStart) / regionLen) * w; const r = useLog ? svgLogScale(b.value, effMax) : b.value / effMax; const y = h - r * (h - 14) - 2; return `${x},${y} ${xEnd},${y}` }).join(' ')
      const x0 = ((visibleBins[0].start - rStart) / regionLen) * w
      const xN = ((visibleBins[visibleBins.length - 1].end - rStart) / regionLen) * w
      s += `<polyline points="${x0},${baseline} ${pts} ${xN},${baseline}" fill="none" stroke="${outColor || theme.textPrimary || '#fff'}" stroke-width="1.5"/>\n`
    }
    const lbl = useLog ? ' log\u2082' : ''
    s += `<text x="2" y="10" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">${effMax.toFixed(1)}${lbl}</text>\n`
  }
  return s
}

function svgAnnotations(data, region, track, w, h, theme) {
  if (!data?.features?.length) return ''
  let s = ''
  const rStart = region.start, rEnd = region.end
  const regionLen = rEnd - rStart
  const FH = 16, RG = 4, AT = 8
  const useArrows = track.useArrows !== false
  const rowEnds = []
  // Filter to only features overlapping the visible region
  const visibleFeats = data.features.filter(f => f.end > rStart && f.start < rEnd)

  for (const feat of visibleFeats) {
    let row = rowEnds.findIndex(e => feat.start >= e)
    if (row === -1) row = rowEnds.length
    rowEnds[row] = feat.end
    const x = ((feat.start - region.start) / regionLen) * w
    const fw = Math.max(2, ((feat.end - feat.start) / regionLen) * w)
    const y = row * (FH + RG) + 2
    if (y + FH > h) continue
    const color = featColor(feat.feature_type, track.color, theme)

    if (feat.sub_features?.length > 0) {
      s += `<rect x="${x}" y="${y + FH / 2 - 1}" width="${fw}" height="2" fill="${color}" opacity="0.4"/>\n`
      for (const sf of feat.sub_features) {
        const sx = ((sf.start - region.start) / regionLen) * w
        const sw = Math.max(1, ((sf.end - sf.start) / regionLen) * w)
        const sc = featColor(sf.feature_type, track.color, theme)
        const sfH = sf.feature_type === 'CDS' ? FH : FH - 6
        const sfY = sf.feature_type === 'CDS' ? y : y + 3
        if (useArrows) { s += svgArrow(sc, sx, sfY, sw, sfH, sf.strand || feat.strand, AT) }
        else { s += `<rect x="${sx}" y="${sfY}" width="${sw}" height="${sfH}" fill="${sc}"/>\n` }
      }
    } else {
      if (useArrows) { s += svgArrow(color, x, y, fw, FH, feat.strand, AT) }
      else { s += `<rect x="${x}" y="${y}" width="${fw}" height="${FH}" fill="${color}"/>\n` }
    }

    if (fw > 20) {
      const label = esc(feat.name || feat.feature_type)
      const maxChars = Math.floor((fw - (useArrows ? AT : 0) - 4) / 6)
      if (maxChars > 0) {
        s += `<text x="${x + 3}" y="${y + FH - 4}" fill="#fff" font-size="10">${label.slice(0, maxChars)}</text>\n`
      }
    }
  }
  return s
}

function svgArrow(color, x, y, w, h, strand, tipSize) {
  const tip = Math.min(tipSize, w * 0.4)
  let pts
  if (strand === '+') {
    pts = `${x},${y} ${x + w - tip},${y} ${x + w},${y + h / 2} ${x + w - tip},${y + h} ${x},${y + h}`
  } else if (strand === '-') {
    pts = `${x + tip},${y} ${x + w},${y} ${x + w},${y + h} ${x + tip},${y + h} ${x},${y + h / 2}`
  } else {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>\n`
  }
  return `<polygon points="${pts}" fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>\n`
}

function svgVariants(data, region, track, w, h, theme) {
  if (!data?.variants?.length) return ''
  let s = ''
  const rStart = region.start, rEnd = region.end
  const regionLen = rEnd - rStart
  const barAuto = track.barAutoWidth !== false
  const barFixedPx = track.barWidth || 2
  const lineW = barAuto ? 1 : Math.max(0.5, barFixedPx)
  const dotR = barAuto ? 5 : Math.max(2, barFixedPx * 2)
  // Filter to only variants within the visible region
  const visibleVars = data.variants.filter(v => v.pos >= rStart && v.pos <= rEnd)
  for (const v of visibleVars) {
    const x = ((v.pos - region.start) / regionLen) * w
    const color = varColor(v.ref, v.alt)
    s += `<line x1="${x}" y1="${h - 4}" x2="${x}" y2="14" stroke="${color}" stroke-width="${lineW}"/>\n`
    s += `<circle cx="${x}" cy="10" r="${dotR}" fill="${color}"/>\n`
    if (regionLen < 5000) {
      s += `<text x="${x}" y="${h - 6}" text-anchor="middle" fill="${theme.textPrimary}" font-size="9" font-family="Arial, Helvetica, sans-serif">${esc(v.ref)}>${esc((v.alt[0] || '?'))}</text>\n`
    }
  }
  return s
}

// ─── Canvas (raster) builder ────────────────────────────────────────────────

function buildCanvas(region, tracks, theme, trackW, labelW, rulerH, totalH, fullW, includeRuler, includeLabels) {
  const canvas = document.createElement('canvas')
  canvas.width = fullW; canvas.height = totalH
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = theme.canvasBg; ctx.fillRect(0, 0, fullW, totalH)

  // Grab existing rendered canvases from the DOM and composite them
  let yOff = 0
  if (includeRuler) {
    const rulerCanvas = document.querySelector('canvas') // first canvas is ruler
    if (rulerCanvas) {
      try {
        ctx.drawImage(rulerCanvas, 0, 0, rulerCanvas.width, rulerCanvas.height, labelW, 0, trackW, rulerH)
      } catch {}
    }
    yOff += rulerH
  }

  const allCanvases = document.querySelectorAll('canvas')
  let canvasIdx = 1 // skip ruler
  for (const track of tracks) {
    if (includeLabels) {
      ctx.fillStyle = theme.panelBg; ctx.fillRect(0, yOff, labelW, track.height)
      ctx.fillStyle = theme.trackName; ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText(track.name, 10, yOff + track.height / 2 + 4)
      ctx.strokeStyle = theme.border; ctx.beginPath()
      ctx.moveTo(labelW, yOff); ctx.lineTo(labelW, yOff + track.height); ctx.stroke()
    }
    if (allCanvases[canvasIdx]) {
      try {
        ctx.drawImage(allCanvases[canvasIdx], 0, 0, allCanvases[canvasIdx].width, allCanvases[canvasIdx].height, labelW, yOff, trackW, track.height)
      } catch {}
    }
    ctx.strokeStyle = theme.border; ctx.beginPath()
    ctx.moveTo(0, yOff + track.height); ctx.lineTo(fullW, yOff + track.height); ctx.stroke()
    yOff += track.height
    canvasIdx++
  }
  return canvas
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatBp(pos) {
  if (pos >= 1_000_000) return `${(pos / 1_000_000).toFixed(2)}M`
  if (pos >= 1_000) return `${(pos / 1_000).toFixed(1)}k`
  return String(pos)
}

function adjustColorSvg(hex, delta) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  const c = v => Math.max(0, Math.min(255, parseInt(v, 16) + delta))
  return `rgb(${c(m[1])},${c(m[2])},${c(m[3])})`
}

function featColor(type, trackColor, theme) {
  switch (type?.toLowerCase()) {
    case 'cds': return theme?.geneCds || '#66bb6a'; case 'exon': return theme?.geneExon || '#42a5f5'; case 'gene': return theme?.geneGene || '#7e57c2'
    case 'mrna': case 'transcript': return theme?.geneTranscript || '#ab47bc'
    case 'utr': case '3utr': case '5utr': return theme?.geneUtr || '#26c6da'
    case 'rrna': return theme?.geneRrna || '#ffa726'; case 'trna': return theme?.geneTrna || '#ef5350'; case 'repeat_region': return theme?.geneRepeat || '#8d6e63'
    default: return trackColor || theme?.geneDefault || '#80cbc4'
  }
}

function varColor(ref, alts) {
  const alt = alts[0] || ''
  if (ref.length === 1 && alt.length === 1) return '#ffb74d'
  if (alt.length > ref.length) return '#81c784'
  if (alt.length < ref.length) return '#e57373'
  return '#b0bec5'
}

function makeStyles(t) {
  return {
    overlay: { position: 'fixed', inset: 0, background: t.overlayBg, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    panel: { background: t.panelBg, border: `1px solid ${t.borderAccent}`, borderRadius: 8, padding: 0, minWidth: 380, maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${t.border}` },
    title: { fontSize: 14, fontWeight: 700, color: t.textPrimary },
    closeBtn: { background: 'none', border: 'none', color: t.textSecondary, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' },
    body: { padding: '12px 16px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 },
    row: { display: 'flex', alignItems: 'center', gap: 10 },
    label: { fontSize: 12, color: t.textSecondary, width: 80, flexShrink: 0 },
    input: { background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '3px 6px', fontSize: 12, width: 80 },
    cb: { fontSize: 12, color: t.textPrimary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 },
    fmtBtn: { background: t.panelBg, borderRadius: 4, color: t.textPrimary, cursor: 'pointer', padding: '4px 14px', fontSize: 12, fontWeight: 600 },
    btn: { background: t.btnBg, border: 'none', borderRadius: 4, color: t.btnText, padding: '6px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: `1px solid ${t.border}` },
  }
}
