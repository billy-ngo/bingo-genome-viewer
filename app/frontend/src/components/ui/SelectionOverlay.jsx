/**
 * SelectionOverlay.jsx — Renders a highlighted region and hover tooltip
 * for right-click-drag selections on the track area.
 *
 * Positioned absolutely inside each track's canvas container.
 * Shows region coordinates, length, and summary stats on hover.
 */
import React, { useState, useRef, useCallback } from 'react'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'

export default function SelectionOverlay({ width, height, trackData, trackType }) {
  const { region, selection, clearSelection } = useBrowser()
  const { theme } = useTheme()
  const [hover, setHover] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const overlayRef = useRef(null)

  const onMouseMove = useCallback((e) => {
    if (!overlayRef.current) return
    const rect = overlayRef.current.getBoundingClientRect()
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setHover(true)
  }, [])

  const onMouseLeave = useCallback(() => setHover(false), [])

  if (!selection || !region || selection.chrom !== region.chrom) return null

  const regionLen = region.end - region.start
  if (regionLen <= 0) return null

  // Map selection to pixel coordinates
  const leftFrac = (selection.start - region.start) / regionLen
  const rightFrac = (selection.end - region.start) / regionLen
  const pxLeft = Math.max(0, leftFrac * width)
  const pxRight = Math.min(width, rightFrac * width)
  const pxWidth = pxRight - pxLeft

  if (pxWidth < 1) return null

  // Compute summary stats from track data
  const stats = computeStats(selection, trackData, trackType)

  const selLen = selection.end - selection.start

  // Tooltip positioning: flip if too close to right edge
  const tipWidth = 240
  let tipX = tooltipPos.x + 12
  if (tipX + tipWidth > width) tipX = tooltipPos.x - tipWidth - 12

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute', top: 0, left: 0,
        width, height, pointerEvents: 'none',
      }}
    >
      {/* Highlight rectangle */}
      <div
        style={{
          position: 'absolute',
          left: pxLeft, top: 0, width: pxWidth, height: '100%',
          background: 'rgba(100, 181, 246, 0.2)',
          borderLeft: '1px solid rgba(100, 181, 246, 0.6)',
          borderRight: '1px solid rgba(100, 181, 246, 0.6)',
          pointerEvents: 'auto',
          cursor: 'crosshair',
        }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={(e) => { e.stopPropagation(); clearSelection() }}
      />

      {/* Tooltip */}
      {hover && (
        <div
          style={{
            position: 'absolute',
            left: tipX,
            top: Math.max(4, tooltipPos.y - 60),
            background: theme.panelBg,
            border: `1px solid ${theme.borderAccent}`,
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: 11,
            color: theme.textPrimary,
            lineHeight: 1.6,
            pointerEvents: 'none',
            zIndex: 100,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            minWidth: 180,
            maxWidth: tipWidth,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>
            Selected Region
          </div>
          <div><span style={{ color: theme.textSecondary }}>Region:</span> {selection.chrom}:{selection.start.toLocaleString()}-{selection.end.toLocaleString()}</div>
          <div><span style={{ color: theme.textSecondary }}>Length:</span> {selLen.toLocaleString()} bp</div>
          {stats.map((s, i) => (
            <div key={i}><span style={{ color: theme.textSecondary }}>{s.label}:</span> {s.value}</div>
          ))}
          <div style={{ fontSize: 9, color: theme.textTertiary, marginTop: 4 }}>
            Click to dismiss
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Compute summary stats for the selected region based on available track data.
 */
function computeStats(selection, trackData, trackType) {
  const stats = []
  if (!trackData) return stats

  if (trackType === 'reads' && trackData.reads) {
    const reads = trackData.reads.filter(
      r => r.end > selection.start && r.start < selection.end
    )
    stats.push({ label: 'Reads in region', value: reads.length.toLocaleString() })

    // Count insertions from CIGAR strings
    let insertions = 0
    for (const r of reads) {
      if (r.cigar) {
        const matches = r.cigar.match(/(\d+)I/g)
        if (matches) {
          for (const m of matches) insertions += parseInt(m)
        }
      }
    }
    if (insertions > 0) {
      stats.push({ label: 'Insertion bases', value: insertions.toLocaleString() })
    }

    // Average MAPQ
    if (reads.length > 0) {
      const avgMapq = reads.reduce((s, r) => s + (r.mapq || 0), 0) / reads.length
      stats.push({ label: 'Avg MAPQ', value: avgMapq.toFixed(1) })
    }
  }

  if ((trackType === 'coverage' || trackType === 'reads') && trackData.bins) {
    const bins = trackData.bins.filter(
      b => b.end > selection.start && b.start < selection.end
    )
    if (bins.length > 0) {
      const values = bins.map(b => b.value)
      const avg = values.reduce((s, v) => s + v, 0) / values.length
      const max = Math.max(...values)
      const min = Math.min(...values)
      stats.push({ label: 'Avg coverage', value: avg.toFixed(1) })
      stats.push({ label: 'Max coverage', value: max.toFixed(1) })
      if (min !== max) stats.push({ label: 'Min coverage', value: min.toFixed(1) })
    }
  }

  if (trackType === 'variants' && trackData.variants) {
    const variants = trackData.variants.filter(
      v => v.pos >= selection.start && v.pos < selection.end
    )
    stats.push({ label: 'Variants in region', value: variants.length.toLocaleString() })
  }

  if ((trackType === 'annotations' || trackType === 'genome_annotations') && trackData.features) {
    const features = trackData.features.filter(
      f => f.end > selection.start && f.start < selection.end
    )
    stats.push({ label: 'Features in region', value: features.length.toLocaleString() })
  }

  return stats
}
