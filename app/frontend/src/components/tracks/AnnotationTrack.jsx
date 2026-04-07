/**
 * AnnotationTrack.jsx — Canvas renderer for gene/feature annotations (GenBank, GFF, BED).
 *
 * Draws gene arrows with CDS/exon sub-features, strand direction indicators,
 * and hover tooltips showing feature attributes. Warns when features are hidden.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import { useTrackData, getCachedDataForTrack } from '../../hooks/useTrackData'
import { genomeApi } from '../../api/client'

const FEAT_HEIGHT = 16
const NUCL_FEAT_HEIGHT = 22  // taller when showing nucleotides
const ROW_GAP = 4
const ARROW_TIP = 8
const NUCL_PX_THRESHOLD = 6  // min px/bp to show nucleotide letters
const BASE_COLORS = { A: '#4caf50', T: '#f44336', C: '#2196f3', G: '#ff9800', N: '#9e9e9e' }

export default function AnnotationTrack({ track, width, height, onWarning }) {
  const canvasRef = useRef(null)
  const { region, navigateTo, setSelection } = useBrowser()
  const { tracks } = useTracks()
  const { theme } = useTheme()
  const { data, loading, error } = useTrackData(track, region, width)
  const useArrows = track.useArrows !== false
  const showNucleotides = track.showNucleotides !== false
  const hitBoxesRef = useRef([])   // [{feat, x, y, w, h}, ...]
  const [tooltip, setTooltip] = useState(null)  // { feat, x, y }
  const [refSeq, setRefSeq] = useState(null)
  const refFetchRef = useRef(null)

  // Fetch reference sequence when zoomed in enough
  useEffect(() => {
    if (!region || !showNucleotides) { setRefSeq(null); return }
    const regionLen = region.end - region.start
    const pxPerBp = width / regionLen
    if (pxPerBp < NUCL_PX_THRESHOLD || regionLen > 2000) { setRefSeq(null); return }

    if (refSeq && refSeq.chrom === region.chrom &&
        refSeq.start <= region.start && refSeq.end >= region.end) return

    const fetchStart = Math.max(0, region.start - 500)
    const fetchEnd = region.end + 500
    const key = `${region.chrom}:${fetchStart}-${fetchEnd}`
    if (refFetchRef.current === key) return
    refFetchRef.current = key

    genomeApi.sequence(region.chrom, fetchStart, fetchEnd)
      .then(res => setRefSeq({ chrom: region.chrom, start: fetchStart, end: fetchEnd, sequence: res.data.sequence }))
      .catch(() => {})
  }, [region?.chrom, region?.start, region?.end, width, showNucleotides])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = theme.canvasBg
    ctx.fillRect(0, 0, width, height)

    hitBoxesRef.current = []

    if (loading && !data?.features?.length) {
      ctx.fillStyle = theme.textTertiary
      ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText('Loading\u2026', 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (error) {
      ctx.fillStyle = '#ef9a9a'
      ctx.font = '11px Arial, Helvetica, sans-serif'
      ctx.fillText(typeof error === 'string' ? error : JSON.stringify(error), 8, height / 2 + 4)
      if (onWarning) onWarning(null)
      return
    }
    if (!data?.features?.length) {
      if (data) {
        ctx.fillStyle = theme.textTertiary
        ctx.font = '11px Arial, Helvetica, sans-serif'
        ctx.fillText('No features in region', 8, height / 2 + 4)
      }
      if (onWarning) onWarning(null)
      return
    }

    const regionLen = region.end - region.start
    const pxPerBp = width / regionLen
    const showBases = showNucleotides && pxPerBp >= NUCL_PX_THRESHOLD && refSeq != null
    const fh = showBases ? NUCL_FEAT_HEIGHT : FEAT_HEIGHT
    const rowEnds = []
    const boxes = []
    let hiddenCount = 0

    // Draw reference nucleotide strip at the bottom of the track
    if (showBases) {
      const stripH = 14
      const stripY = height - stripH
      // Background for the strip
      ctx.fillStyle = theme.canvasBg
      ctx.fillRect(0, stripY, width, stripH)
      ctx.strokeStyle = theme.border || '#333'
      ctx.lineWidth = 0.5
      ctx.beginPath(); ctx.moveTo(0, stripY); ctx.lineTo(width, stripY); ctx.stroke()
      // Draw each base
      const fontSize = Math.min(10, pxPerBp - 1)
      if (fontSize >= 5) {
        ctx.font = `bold ${fontSize}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (let bp = Math.floor(region.start); bp < Math.ceil(region.end); bp++) {
          if (refSeq && bp >= refSeq.start && bp < refSeq.end) {
            const base = (refSeq.sequence[bp - refSeq.start] || '').toUpperCase()
            const bx = ((bp - region.start) / regionLen) * width
            ctx.fillStyle = BASE_COLORS[base] || '#999'
            ctx.fillText(base, bx + pxPerBp / 2, stripY + stripH / 2)
          }
        }
      }
    }

    // Pre-filter region overrides for current chromosome
    const barOverlays = (track.regionOverlays || []).filter(o => o.barColor && o.chrom === region.chrom)

    for (const feat of data.features) {
      let row = rowEnds.findIndex(e => feat.start >= e)
      if (row === -1) row = rowEnds.length
      rowEnds[row] = feat.end

      const x = ((feat.start - region.start) / regionLen) * width
      const w = Math.max(2, ((feat.end - feat.start) / regionLen) * width)
      const y = row * (fh + ROW_GAP) + 2
      if (y + fh > height) { hiddenCount++; continue }

      // Check region overrides for feature recoloring
      let regionBarColor = null
      if (barOverlays.length > 0) {
        const featMid = (feat.start + feat.end) / 2
        for (const o of barOverlays) {
          if (featMid >= o.start && featMid < o.end) { regionBarColor = o.barColor; break }
        }
      }
      const color = regionBarColor || featureColor(feat.feature_type, track, theme)

      if (feat.sub_features && feat.sub_features.length > 0) {
        ctx.fillStyle = color + '66'
        ctx.fillRect(x, y + fh / 2 - 1, w, 2)
        for (const sf of feat.sub_features) {
          const sx = ((sf.start - region.start) / regionLen) * width
          const sw = Math.max(1, ((sf.end - sf.start) / regionLen) * width)
          const sfColor = featureColor(sf.feature_type, track, theme)
          const sfH = sf.feature_type === 'CDS' ? fh : fh - 6
          const sfY = sf.feature_type === 'CDS' ? y : y + 3
          if (useArrows) {
            drawArrowRect(ctx, sfColor, sx, sfY, sw, sfH, sf.strand || feat.strand)
          } else {
            ctx.fillStyle = sfColor
            ctx.fillRect(sx, sfY, sw, sfH)
          }
        }
      } else {
        if (useArrows) {
          drawArrowRect(ctx, color, x, y, w, fh, feat.strand)
        } else {
          ctx.fillStyle = color
          ctx.fillRect(x, y, w, fh)
        }
      }

      // Draw nucleotide bases when zoomed in
      if (showBases) {
        const featStart = Math.max(feat.start, region.start)
        const featEnd = Math.min(feat.end, region.end)
        for (let bp = featStart; bp < featEnd; bp++) {
          if (refSeq && bp >= refSeq.start && bp < refSeq.end) {
            const base = (refSeq.sequence[bp - refSeq.start] || '').toUpperCase()
            const bx = ((bp - region.start) / regionLen) * width
            const bw = pxPerBp
            if (bw >= 6) {
              ctx.fillStyle = BASE_COLORS[base] || '#999'
              ctx.font = `bold ${Math.min(10, bw - 1)}px monospace`
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillText(base, bx + bw / 2, y + fh / 2)
            }
          }
        }
      } else if (w > 20) {
        // Feature name label (only when not showing nucleotides)
        ctx.fillStyle = '#fff'
        ctx.font = '10px Arial, Helvetica, sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        const label = feat.name || feat.feature_type
        const maxChars = Math.floor((w - (useArrows ? ARROW_TIP : 0) - 4) / 6)
        if (maxChars > 0) {
          ctx.fillText(label.slice(0, maxChars), x + 3, y + fh - 4)
        }
      }

      // Store hit-box for tooltip
      boxes.push({ feat, x, y, w, h: fh })
    }

    hitBoxesRef.current = boxes

    if (onWarning) {
      onWarning(hiddenCount > 0
        ? `${hiddenCount} feature${hiddenCount > 1 ? 's' : ''} hidden \u2014 increase track height to show all`
        : null)
    }
  }, [data, loading, error, width, height, region, refSeq, track.color, track.annotationColors, useArrows, track.showNucleotides, track.regionOverlays, theme])

  const onMouseMove = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (width / rect.width)
    const my = (e.clientY - rect.top) * (height / rect.height)

    for (const box of hitBoxesRef.current) {
      if (mx >= box.x && mx <= box.x + box.w && my >= box.y && my <= box.y + box.h) {
        // Use viewport-fixed coords so portal tooltip never gets clipped
        const tipX = Math.min(e.clientX + 14, window.innerWidth - 300)
        const tipY = Math.min(e.clientY + 14, window.innerHeight - 260)
        setTooltip({
          feat: box.feat,
          x: Math.max(4, tipX),
          y: Math.max(4, tipY),
        })
        return
      }
    }
    setTooltip(null)
  }, [width, height])

  const onMouseLeave = useCallback(() => setTooltip(null), [])

  const onDoubleClick = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas || !region) return
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (width / rect.width)
    const my = (e.clientY - rect.top) * (height / rect.height)

    for (const box of hitBoxesRef.current) {
      if (mx >= box.x && mx <= box.x + box.w && my >= box.y && my <= box.y + box.h) {
        const feat = box.feat
        const featLen = feat.end - feat.start
        // Add ~15% context on each side
        const context = featLen * 0.15 / (1 - 0.30)  // so gene occupies ~70% of view
        const viewStart = feat.start - context
        const viewEnd = feat.end + context
        navigateTo(region.chrom, viewStart, viewEnd)
        setSelection({ chrom: region.chrom, start: feat.start, end: feat.end })
        setTooltip(null)
        return
      }
    }
  }, [width, height, region, navigateTo])

  // Compute per-track stats for the hovered feature
  const trackStats = tooltip ? computeTrackStats(tooltip.feat, tracks, region?.chrom) : []

  const tooltipEl = tooltip ? createPortal(
    <div style={{
      position: 'fixed',
      left: tooltip.x,
      top: tooltip.y,
      background: theme.tooltipBg,
      border: `1px solid ${theme.tooltipBorder}`,
      borderRadius: 4,
      padding: '6px 10px',
      color: theme.textPrimary,
      fontSize: 11,
      lineHeight: 1.5,
      maxWidth: 280,
      zIndex: 10000,
      pointerEvents: 'none',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 2 }}>
        {tooltip.feat.name || tooltip.feat.feature_type}
      </div>
      <TooltipRow label="Type" value={tooltip.feat.feature_type} />
      <TooltipRow label="Strand" value={tooltip.feat.strand || '.'} />
      <TooltipRow label="Location" value={`${tooltip.feat.start.toLocaleString()}\u2013${tooltip.feat.end.toLocaleString()}`} />
      <TooltipRow label="Length" value={`${(tooltip.feat.end - tooltip.feat.start).toLocaleString()} bp`} />
      {tooltip.feat.attributes?.gene && tooltip.feat.attributes.gene !== tooltip.feat.name && (
        <TooltipRow label="Gene" value={tooltip.feat.attributes.gene} />
      )}
      {tooltip.feat.attributes?.locus_tag && (
        <TooltipRow label="Locus" value={tooltip.feat.attributes.locus_tag} />
      )}
      {tooltip.feat.attributes?.product && (
        <TooltipRow label="Product" value={tooltip.feat.attributes.product} />
      )}
      {tooltip.feat.attributes?.note && (
        <TooltipRow label="Note" value={String(tooltip.feat.attributes.note).slice(0, 120)} />
      )}
      {trackStats.length > 0 && (
        <>
          <div style={{ borderTop: `1px solid ${theme.tooltipBorder}`, margin: '4px 0', paddingTop: 4 }}>
            <span style={{ color: theme.textSecondary, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>
              Track totals in gene
            </span>
          </div>
          {trackStats.map(ts => (
            <div key={ts.trackId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: theme.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {ts.name}
              </span>
              <span style={{ color: theme.textPrimary, fontWeight: 600, flexShrink: 0 }}>
                {ts.total.toFixed(1)}
              </span>
            </div>
          ))}
        </>
      )}
    </div>,
    document.body
  ) : null

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onDoubleClick={onDoubleClick}
      />
      {tooltipEl}
    </div>
  )
}

function TooltipRow({ label, value }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <span style={{ opacity: 0.6, flexShrink: 0 }}>{label}:</span>
      <span>{value}</span>
    </div>
  )
}

/** Sum cached bin values for coverage/reads tracks that overlap a feature's range */
function computeTrackStats(feat, allTracks, chrom) {
  if (!feat || !chrom) return []
  const stats = []
  for (const t of allTracks) {
    if (t.track_type !== 'coverage' && t.track_type !== 'reads') continue
    const cached = getCachedDataForTrack(t.id, chrom)
    if (!cached?.bins?.length) continue
    let total = 0
    for (const bin of cached.bins) {
      if (bin.end <= feat.start || bin.start >= feat.end) continue
      // Sum absolute values (counts both forward and reverse for Tn-seq)
      const fwd = bin.forward != null ? bin.forward : Math.max(0, bin.value || 0)
      const rev = bin.reverse != null ? Math.abs(bin.reverse) : Math.abs(Math.min(0, bin.value || 0))
      total += fwd + rev
    }
    if (total > 0) {
      stats.push({ trackId: t.id, name: t.name, total })
    }
  }
  return stats
}

function drawArrowRect(ctx, color, x, y, w, h, strand) {
  ctx.fillStyle = color
  const tip = Math.min(ARROW_TIP, w * 0.4)
  ctx.beginPath()
  if (strand === '+') {
    ctx.moveTo(x, y)
    ctx.lineTo(x + w - tip, y)
    ctx.lineTo(x + w, y + h / 2)
    ctx.lineTo(x + w - tip, y + h)
    ctx.lineTo(x, y + h)
    ctx.closePath()
  } else if (strand === '-') {
    ctx.moveTo(x + tip, y)
    ctx.lineTo(x + w, y)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x + tip, y + h)
    ctx.lineTo(x, y + h / 2)
    ctx.closePath()
  } else {
    ctx.rect(x, y, w, h)
  }
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 0.5
  ctx.stroke()
}

function featureColor(type, track, theme) {
  const ac = track.annotationColors
  switch (type?.toLowerCase()) {
    case 'cds': return ac?.cds || theme?.geneCds || '#66bb6a'
    case 'exon': return ac?.exon || theme?.geneExon || '#42a5f5'
    case 'gene': return ac?.gene || theme?.geneGene || '#7e57c2'
    case 'mrna':
    case 'transcript': return ac?.transcript || theme?.geneTranscript || '#ab47bc'
    case 'utr':
    case '3utr':
    case '5utr': return ac?.utr || theme?.geneUtr || '#26c6da'
    case 'rrna': return ac?.rrna || theme?.geneRrna || '#ffa726'
    case 'trna': return ac?.trna || theme?.geneTrna || '#ef5350'
    case 'repeat_region': return ac?.repeat || theme?.geneRepeat || '#8d6e63'
    default: return ac?.default || track.color || theme?.geneDefault || '#80cbc4'
  }
}
