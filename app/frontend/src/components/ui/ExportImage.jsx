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
import { getLiveTrackData, computeAutoScale } from '../../hooks/useTrackData'
import NumberInput from './NumberInput'

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
      // Overlay groups occupy a single row (host height), not the sum of members.
      const units = buildExportUnits(selectedTracks)
      const totalH = rulerH + units.reduce((sum, u) => sum + unitHeight(u), 0)

      if (format === 'svg') {
        const svg = buildSVG(region, selectedTracks, theme, trackW, labelW, rulerH, totalH, includeRuler, includeLabels, tracks)
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
            <NumberInput value={exportWidth} onCommit={v => setExportWidth(v ?? 1200)}
              min={400} max={4000} integer style={S.input} />
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

// ─── Render units (overlay-group aware) ─────────────────────────────────────

/** Group a flat track list into render units, mirroring the on-screen layout:
 *  standalone tracks render one row each; overlay-group members render together
 *  in one row at the position of the first member. */
function buildExportUnits(tracks) {
  const seen = new Set()
  const units = []
  for (const t of tracks) {
    if (t.overlayGroup) {
      if (seen.has(t.overlayGroup)) continue
      seen.add(t.overlayGroup)
      const members = tracks.filter(m => m.overlayGroup === t.overlayGroup)
      units.push({ type: 'overlay', members })
    } else {
      units.push({ type: 'single', track: t })
    }
  }
  return units
}

function unitHeight(u) {
  return u.type === 'overlay' ? u.members[0].height : u.track.height
}

// ─── SVG Builder ────────────────────────────────────────────────────────────

function buildSVG(region, tracks, theme, trackW, labelW, rulerH, totalH, includeRuler, includeLabels, allTracks) {
  const w = trackW + labelW
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
  svg += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" font-family="Arial, Helvetica, sans-serif">\n`
  svg += `<rect width="${w}" height="${totalH}" fill="${theme.canvasBg}"/>\n`

  let yOff = 0

  if (includeRuler) {
    svg += svgRuler(region, labelW, 0, trackW, 30, theme)
    yOff += rulerH
  }

  const units = buildExportUnits(tracks)
  for (const [i, unit] of units.entries()) {
    const uH = unitHeight(unit)
    // Per-unit clip sized to THIS row's box. A single shared clip rect of
    // height=totalH (referenced from each translated group under the default
    // userSpaceOnUse) spans root-y [yOff, yOff+totalH], so lower rows' clip
    // masks extend far below the document. Illustrator imports each clip-path as
    // a real mask object and unions their bounds into the artwork bbox, inflating
    // the artboard to ~2x the height — the "large empty space" below the image.
    // A rect of height=uH confines each clip to its own row, so the imported
    // bounds collapse back to the document rectangle (the viewBox).
    const clipId = `trackClip-${i}`
    const groupName = unit.type === 'overlay'
      ? `overlay-${i}` : esc(unit.track.name).replace(/\s+/g, '_')
    svg += `<clipPath id="${clipId}"><rect width="${trackW}" height="${uH}"/></clipPath>\n`
    svg += `<g transform="translate(${labelW},${yOff})" clip-path="url(#${clipId})" id="track-${groupName}">\n`
    svg += `<rect width="${trackW}" height="${uH}" fill="${theme.canvasBg}" class="track-bg"/>\n`

    if (unit.type === 'overlay') {
      // Layered, transparent members sharing one axis. Each member's bars/outline
      // are wrapped in a group with its overlay opacity so they blend exactly like
      // the on-screen layers; only the base (first VISIBLE) member draws the scale
      // labels. Mirror the on-screen rules: skip hidden members; all layers use
      // the group host's scale/log settings and a group-wide negative layout.
      const groupHost = unit.members[0]
      const vis = unit.members.filter(m => m.visible !== false)
      const groupHasNeg = unit.members.some(m => (getLiveTrackData(m.id)?.min_value || 0) < 0)
      vis.forEach((m, mi) => {
        const sm = { ...m, logScale: groupHost.logScale, scaleMax: groupHost.scaleMax, scaleMin: groupHost.scaleMin }
        const data = getLiveTrackData(m.id)
        const parts = svgCoverageParts(data, region, sm, trackW, uH, theme, allTracks, groupHasNeg)
        const op = m.overlayOpacity ?? 0.6
        if (parts.bars) svg += `<g class="track-bars" opacity="${op}">\n${parts.bars}</g>\n`
        if (parts.outline) svg += `<g class="track-outline" opacity="${op}">\n${parts.outline}</g>\n`
        if (mi === 0 && parts.labels) svg += `<g class="track-labels">\n${parts.labels}</g>\n`
      })
      if (vis[0]) svg += svgRegionHighlights(vis[0], region, trackW, uH)
    } else {
      const track = unit.track
      const data = getLiveTrackData(track.id)
      if (track.track_type === 'coverage' || track.track_type === 'reads') {
        if (track.track_type === 'reads' && data?.reads != null && !data?.bins?.length) {
          // Zoomed-in read pileup — impractical to vectorize faithfully, so embed
          // the live canvas as a raster image so the SVG matches the screen.
          const img = trackCanvasDataURL(track.id)
          if (img) svg += `<image x="0" y="0" width="${trackW}" height="${uH}" preserveAspectRatio="none" href="${img}" xlink:href="${img}"/>\n`
        } else {
          const parts = svgCoverageParts(data, region, track, trackW, uH, theme, allTracks)
          if (parts.bars) svg += `<g class="track-bars">\n${parts.bars}</g>\n`
          if (parts.outline) svg += `<g class="track-outline">\n${parts.outline}</g>\n`
          if (parts.labels) svg += `<g class="track-labels">\n${parts.labels}</g>\n`
        }
      } else if (track.track_type === 'annotations' || track.track_type === 'genome_annotations') {
        svg += `<g class="track-features">\n${svgAnnotations(data, region, track, trackW, uH, theme)}</g>\n`
      } else if (track.track_type === 'variants') {
        svg += `<g class="track-variants">\n${svgVariants(data, region, track, trackW, uH, theme)}</g>\n`
      }
      svg += svgRegionHighlights(track, region, trackW, uH)
    }
    svg += `</g>\n`

    // Draw labels ON TOP so they are never obscured
    if (includeLabels) {
      svg += `<rect x="0" y="${yOff}" width="${labelW}" height="${uH}" fill="${theme.panelBg}"/>\n`
      svg += `<line x1="${labelW}" y1="${yOff}" x2="${labelW}" y2="${yOff + uH}" stroke="${theme.border}"/>\n`
      if (unit.type === 'overlay') {
        // Legend: one colored line per member (clipped to the row height).
        unit.members.forEach((m, mi) => {
          const ly = yOff + 14 + mi * 13
          if (ly > yOff + uH - 3) return
          svg += `<rect x="8" y="${ly - 7}" width="8" height="8" rx="1" fill="${m.color}"/>\n`
          svg += `<text x="20" y="${ly}" fill="${theme.trackName}" font-size="10">${esc(m.name)}</text>\n`
        })
      } else {
        svg += `<text x="10" y="${yOff + uH / 2 + 4}" fill="${theme.trackName}" font-size="11" font-weight="600">${esc(unit.track.name)}</text>\n`
      }
    }
    svg += `<line x1="0" y1="${yOff + uH}" x2="${w}" y2="${yOff + uH}" stroke="${theme.border}"/>\n`
    yOff += uH
  }

  svg += `</svg>`
  return svg
}

/** Persistent region highlight overlays (RegionColorEditor highlightColor),
 *  mirroring SelectionOverlay so the export matches the screen. */
function svgRegionHighlights(track, region, w, h) {
  const overlays = (track.regionOverlays || []).filter(o => o.highlightColor && o.chrom === region.chrom)
  if (!overlays.length) return ''
  const regionLen = region.end - region.start
  if (regionLen <= 0) return ''
  let s = ''
  for (const o of overlays) {
    const x0 = Math.max(0, ((o.start - region.start) / regionLen) * w)
    const x1 = Math.min(w, ((o.end - region.start) / regionLen) * w)
    const ow = x1 - x0
    if (ow < 1) continue
    s += `<rect x="${x0}" y="0" width="${ow}" height="${h}" fill="${o.highlightColor}" opacity="${o.highlightOpacity || 0.35}"/>\n`
  }
  return s
}

/** PNG data URL of a track's live on-screen canvas (looked up by id), used to
 *  embed an un-vectorizable read pileup into the SVG so it's not blank. */
function trackCanvasDataURL(trackId) {
  try {
    const host = document.querySelector(`[data-export-track-id="${cssEscape(trackId)}"]`)
    const c = host ? host.querySelector('canvas') : null
    return c ? c.toDataURL('image/png') : null
  } catch {
    return null
  }
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

function svgSmoothValues(values, radius) {
  if (radius <= 0) return values
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0
    const lo = Math.max(0, i - radius), hi = Math.min(values.length - 1, i + radius)
    for (let j = lo; j <= hi; j++) { sum += values[j]; count++ }
    out[i] = sum / count
  }
  return out
}

function svgOutlinePath(xs, ys, stroke, smooth) {
  if (xs.length < 2) return ''
  if (smooth) {
    let d = `M${xs[0]},${ys[0]}`
    for (let i = 0; i < xs.length - 1; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2
      const my = (ys[i] + ys[i + 1]) / 2
      d += ` Q${xs[i]},${ys[i]} ${mx},${my}`
    }
    d += ` L${xs[xs.length - 1]},${ys[ys.length - 1]}`
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"/>\n`
  }
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ')
  return `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5"/>\n`
}

function svgLogScale(val, max) {
  if (val <= 0 || max <= 0) return 0
  return Math.log2(val + 1) / Math.log2(max + 1)
}

/** Returns { bars, outline, labels } as separate SVG strings for grouping.
 *  forceHasNeg (optional): override the positive/negative layout decision — used
 *  for overlay members so the whole group shares one coordinate system. */
function svgCoverageParts(data, region, track, w, h, theme, allTracks, forceHasNeg) {
  if (!data?.bins?.length) return { bars: '', outline: '', labels: '' }
  let bars = '', outline = '', labels = ''
  // Match CoverageTrack: the forward/reverse split is decided from the fetched
  // range (stable), but the auto-scale magnitude follows the "fit to visible
  // region" / "link scales" toggles so the export matches what's on screen.
  const hasNeg = forceHasNeg != null ? forceHasNeg : (data.min_value || 0) < 0
  let maxVal = data.max_value || 0
  let minVal = data.min_value || 0
  if (track.autoScaleVisible || track.linkScale || track.overlayGroup) {
    const a = computeAutoScale(track, region, allTracks)
    maxVal = a.max
    minVal = a.min
  }
  const rStart = region.start, rEnd = region.end
  const regionLen = rEnd - rStart
  const color = track.color || '#78909c'
  const userScaleMax = track.scaleMax
  const userScaleMin = track.scaleMin
  const useLog = track.logScale === true
  const visibleBins = data.bins.filter(b => b.end > rStart && b.start < rEnd)

  const barAuto = track.barAutoWidth !== false
  const barFixedPx = track.barWidth || 2
  const pxPerNt = w / regionLen

  const showBars = track.showBars !== false
  const showOutline = track.showOutline === true
  const outColor = track.outlineColor || null
  const outSmooth = track.outlineSmooth || 0

  // Region bar-recolor overlays (RegionColorEditor) — matches CoverageTrack.
  const regionOverlays = (track.regionOverlays || []).filter(o => o.barColor && o.chrom === region.chrom)
  function binOverride(binMid) {
    for (let i = 0; i < regionOverlays.length; i++) {
      const o = regionOverlays[i]
      if (binMid >= o.start && binMid < o.end) return o.barColor
    }
    return null
  }

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
    bars += `<line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="${theme.centerLine}" stroke-width="1"/>\n`
    if (showBars) {
      for (const bin of visibleBins) {
        const x = ((bin.start - rStart) / regionLen) * w
        const bw = autoW(((bin.end - bin.start) / regionLen) * w)
        const fwd = bin.forward != null ? bin.forward : Math.max(0, bin.value)
        const rev = bin.reverse != null ? bin.reverse : Math.min(0, bin.value)
        const ov = binOverride((bin.start + bin.end) / 2)
        if (fwd > 0) { const r = useLog ? svgLogScale(fwd, posMax) : fwd / posMax; const bh = r * topH; bars += `<rect x="${x}" y="${midY - bh}" width="${bw}" height="${bh}" fill="${ov || color}"/>\n` }
        if (rev < 0) { const r = useLog ? svgLogScale(Math.abs(rev), negMax) : Math.abs(rev) / negMax; const bh = r * botH; bars += `<rect x="${x}" y="${midY}" width="${bw}" height="${bh}" fill="${ov || adjustColorSvg(color, -40)}"/>\n` }
      }
    }
    if (showOutline && visibleBins.length > 0) {
      const fwdRaw = visibleBins.map(b => { const v = b.forward != null ? b.forward : Math.max(0, b.value); return v > 0 ? (useLog ? svgLogScale(v, posMax) : v / posMax) : 0 })
      const revRaw = visibleBins.map(b => { const v = b.reverse != null ? b.reverse : Math.min(0, b.value); return v < 0 ? (useLog ? svgLogScale(Math.abs(v), negMax) : Math.abs(v) / negMax) : 0 })
      const fwdS = svgSmoothValues(fwdRaw, outSmooth)
      const revS = svgSmoothValues(revRaw, outSmooth)
      const xs = visibleBins.map(b => ((b.start + b.end) / 2 - rStart) / regionLen * w)
      outline += svgOutlinePath(xs, fwdS.map(r => midY - r * topH), outColor || theme.textPrimary || '#fff', outSmooth > 0)
      outline += svgOutlinePath(xs, revS.map(r => midY + r * botH), outColor || theme.textPrimary || '#fff', outSmooth > 0)
    }
    const lbl = useLog ? ' log\u2082' : ''
    labels += `<text x="2" y="12" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">+${posMax.toFixed(1)}${lbl}</text>\n`
    labels += `<text x="2" y="${h - 2}" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">\u2212${negMax.toFixed(1)}${lbl}</text>\n`
  } else {
    const effMax = userScaleMax != null ? userScaleMax : (maxVal || 1)
    if (showBars) {
      for (const bin of visibleBins) {
        const x = ((bin.start - rStart) / regionLen) * w
        const bw = autoW(((bin.end - bin.start) / regionLen) * w)
        const r = useLog ? svgLogScale(bin.value, effMax) : bin.value / effMax
        const bh = r * (h - 14)
        const ov = binOverride((bin.start + bin.end) / 2)
        bars += `<rect x="${x}" y="${h - bh - 2}" width="${bw}" height="${bh}" fill="${ov || color}"/>\n`
      }
    }
    if (showOutline && visibleBins.length > 0) {
      const rawR = visibleBins.map(b => useLog ? svgLogScale(b.value, effMax) : b.value / effMax)
      const smoothed = svgSmoothValues(rawR, outSmooth)
      const xs = visibleBins.map(b => ((b.start + b.end) / 2 - rStart) / regionLen * w)
      const ys = smoothed.map(r => h - r * (h - 14) - 2)
      outline += svgOutlinePath(xs, ys, outColor || theme.textPrimary || '#fff', outSmooth > 0)
    }
    const lbl = useLog ? ' log\u2082' : ''
    labels += `<text x="2" y="10" fill="${theme.textSecondary}" font-size="10" font-family="Arial, Helvetica, sans-serif">${effMax.toFixed(1)}${lbl}</text>\n`
  }
  return { bars, outline, labels }
}

function svgAnnotations(data, region, track, w, h, theme) {
  if (!data?.features?.length) return ''
  let s = ''
  const rStart = region.start, rEnd = region.end
  const regionLen = rEnd - rStart
  const FH = 16, RG = 4, AT = 8
  const useArrows = track.useArrows !== false
  const rowEnds = []
  // Mirror AnnotationTrack: drop user-hidden feature types BEFORE region filter
  // and row packing, so retained features land on the same rows as on screen.
  const hiddenSet = new Set(track.hiddenFeatureTypes || [])
  const visibleFeats = data.features.filter(f =>
    f.end > rStart && f.start < rEnd && !hiddenSet.has(f.feature_type))
  // Region bar-recolor overlays for the current chromosome (RegionColorEditor)
  const barOverlays = (track.regionOverlays || []).filter(o => o.barColor && o.chrom === region.chrom)

  for (const feat of visibleFeats) {
    let row = rowEnds.findIndex(e => feat.start >= e)
    if (row === -1) row = rowEnds.length
    rowEnds[row] = feat.end
    const x = ((feat.start - region.start) / regionLen) * w
    const fw = Math.max(2, ((feat.end - feat.start) / regionLen) * w)
    const y = row * (FH + RG) + 2
    if (y + FH > h) continue
    // Precedence (matches AnnotationTrack): region recolor → file itemRgb → per-type colour.
    let regionBarColor = null
    if (barOverlays.length > 0) {
      const featMid = (feat.start + feat.end) / 2
      for (const o of barOverlays) { if (featMid >= o.start && featMid < o.end) { regionBarColor = o.barColor; break } }
    }
    const color = regionBarColor || feat.color || featColor(feat.feature_type, track.color, theme)

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

    if (feat.rank != null) {
      // Peak rank label — the rank number, centered on the bar (matches AnnotationTrack).
      const rankLabel = String(feat.rank)
      const tw = rankLabel.length * 6   // ≈ bold 10px monospace width
      if (fw >= tw + 2) {
        const cx = Math.min(Math.max(x + fw / 2, 3 + tw / 2), w - tw / 2 - 1)
        s += `<text x="${cx}" y="${y + FH / 2}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="10" font-weight="bold">${esc(rankLabel)}</text>\n`
      }
    } else if (fw > 20) {
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

  // Composite each track's live canvas, looked up BY IDENTITY (not by DOM
  // position). The previous positional indexing — querySelectorAll('canvas')
  // walked with a fixed +1 ruler offset — mis-mapped every track after any
  // deselected/removed track, compositing the wrong (ghost) image into a
  // neighbour's slot. Identity lookup composites each selected track from
  // its own current canvas and silently skips any that are gone.
  let yOff = 0
  if (includeRuler) {
    const rulerCanvas = document.querySelector('canvas[data-export-ruler]')
      || document.querySelector('canvas') // fallback: first canvas is the ruler
    if (rulerCanvas) {
      try {
        ctx.drawImage(rulerCanvas, 0, 0, rulerCanvas.width, rulerCanvas.height, labelW, 0, trackW, rulerH)
      } catch {}
    }
    yOff += rulerH
  }

  const units = buildExportUnits(tracks)
  for (const unit of units) {
    const uH = unitHeight(unit)
    if (includeLabels) {
      ctx.fillStyle = theme.panelBg; ctx.fillRect(0, yOff, labelW, uH)
      ctx.strokeStyle = theme.border; ctx.beginPath()
      ctx.moveTo(labelW, yOff); ctx.lineTo(labelW, yOff + uH); ctx.stroke()
      if (unit.type === 'overlay') {
        // Legend: one colored swatch + name per member.
        ctx.font = '10px Arial, Helvetica, sans-serif'
        unit.members.forEach((m, mi) => {
          const ly = yOff + 14 + mi * 13
          if (ly > yOff + uH - 3) return
          ctx.fillStyle = m.color; ctx.fillRect(8, ly - 7, 8, 8)
          ctx.fillStyle = theme.trackName; ctx.fillText(m.name, 20, ly)
        })
      } else {
        ctx.fillStyle = theme.trackName; ctx.font = '11px Arial, Helvetica, sans-serif'
        ctx.fillText(unit.track.name, 10, yOff + uH / 2 + 4)
      }
    }
    // Composite the live canvas(es) for this row. Overlay members are drawn in
    // order (base first); each member canvas already carries its baked-in alpha
    // and transparency, so stacking them reproduces the on-screen blend.
    const layers = unit.type === 'overlay'
      ? unit.members.filter(m => m.visible !== false)
      : [unit.track]
    for (const m of layers) {
      const host = document.querySelector(`[data-export-track-id="${cssEscape(m.id)}"]`)
      const srcCanvas = host ? host.querySelector('canvas') : null
      if (srcCanvas) {
        try {
          ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, labelW, yOff, trackW, uH)
        } catch {}
      }
    }
    // Persistent region highlight overlays live in a separate DOM layer
    // (SelectionOverlay), so the track canvas above doesn't include them —
    // paint them on here so the raster export matches the screen.
    const hlTrack = unit.type === 'overlay' ? unit.members[0] : unit.track
    const hl = (hlTrack.regionOverlays || []).filter(o => o.highlightColor && o.chrom === region.chrom)
    if (hl.length) {
      const regionLen = region.end - region.start
      if (regionLen > 0) {
        for (const o of hl) {
          const x0 = labelW + Math.max(0, ((o.start - region.start) / regionLen) * trackW)
          const x1 = labelW + Math.min(trackW, ((o.end - region.start) / regionLen) * trackW)
          const ow = x1 - x0
          if (ow < 1) continue
          ctx.save()
          ctx.globalAlpha = o.highlightOpacity || 0.35
          ctx.fillStyle = o.highlightColor
          ctx.fillRect(x0, yOff, ow, uH)
          ctx.restore()
        }
      }
    }
    ctx.strokeStyle = theme.border; ctx.beginPath()
    ctx.moveTo(0, yOff + uH); ctx.lineTo(fullW, yOff + uH); ctx.stroke()
    yOff += uH
  }
  return canvas
}

/** CSS.escape with a conservative fallback for older runtimes. Track ids are
 *  8-char hex UUIDs or the literal 'genome_annotations', so escaping is mostly
 *  defensive, but a missing CSS.escape would otherwise throw. */
function cssEscape(s) {
  const str = String(s)
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str)
  return str.replace(/["\\]/g, '\\$&')
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
