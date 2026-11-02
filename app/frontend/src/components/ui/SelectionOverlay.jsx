/**
 * SelectionOverlay.jsx — Renders selection highlight and persistent region
 * color overlays on each track. Optimized to avoid unnecessary re-renders.
 *
 * The properties tooltip appears in two ways:
 *   1. on hover — the highlight div has pointer-events:auto and listens for
 *      mousemove / mouseleave.
 *   2. on selection change — when a new selection is created (via right-
 *      click drag or via double-click on a gene), the tooltip auto-appears
 *      anchored to the highlight for a few seconds. This gives immediate
 *      feedback without requiring the user to first move the mouse onto a
 *      highlight that may already be under the cursor.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useBrowser } from '../../store/BrowserContext'
import { useTheme } from '../../store/ThemeContext'
import { fetchSignalStats } from '../../utils/signalStats'
import { formatValue } from '../../utils/coverageStats'

const AUTO_SHOW_MS = 3500  // tooltip dwells this long after a new selection
const STATS_RETRY_MS = 1500  // re-ask while a BAM's coverage is still being computed

export default function SelectionOverlay({ width, height, trackData, trackType, trackId, regionOverlays }) {
  const { region, selection, clearSelection } = useBrowser()
  const { theme } = useTheme()
  const [hover, setHover] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [autoShow, setAutoShow] = useState(false)
  const overlayRef = useRef(null)
  const prevSelKeyRef = useRef(null)

  const isReadTrack = trackType === 'reads'
  const hasOverlays = regionOverlays && regionOverlays.length > 0
  const hasSelection = Boolean(selection && region && selection.chrom === region.chrom)

  // When the selection changes, show the tooltip briefly so the user
  // gets immediate region-properties feedback after right-click drag /
  // double-click — they shouldn't have to wiggle the mouse first.
  useEffect(() => {
    const key = selection
      ? `${selection.chrom}:${selection.start}-${selection.end}`
      : null
    if (key && key !== prevSelKeyRef.current) {
      prevSelKeyRef.current = key
      setAutoShow(true)
      const t = setTimeout(() => setAutoShow(false), AUTO_SHOW_MS)
      return () => clearTimeout(t)
    }
    if (!key) {
      prevSelKeyRef.current = null
      setAutoShow(false)
    }
  }, [selection?.chrom, selection?.start, selection?.end])

  // Exact signal statistics of the selection (coverage/read tracks), fetched
  // from the backend while the tooltip is up — averaging the drawn bins gave
  // numbers that changed with the zoom level.
  const isSignal = trackType === 'coverage' || trackType === 'reads'
  const statsKey = isSignal && trackId && hasSelection && (hover || autoShow)
    ? `${trackId}|${selection.chrom}|${selection.start}|${selection.end}` : null
  const [sig, setSig] = useState(null)   // { key, row }
  useEffect(() => {
    if (!statsKey) return undefined
    const controller = new AbortController()
    let timer = null
    const ask = () => fetchSignalStats({ id: trackId }, selection.chrom, selection.start, selection.end, controller.signal)
      .then(row => {
        if (controller.signal.aborted) return
        setSig({ key: statsKey, row })
        if (row && !row.complete) timer = setTimeout(ask, STATS_RETRY_MS)
      })
    ask()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [statsKey])
  const sigRow = sig && sig.key === statsKey ? sig.row : undefined   // undefined = loading

  const onMouseMove = useCallback((e) => {
    setMousePos({ x: e.clientX, y: e.clientY })
    setHover(true)
  }, [])
  const onMouseLeave = useCallback(() => setHover(false), [])

  const onContextMenu = useCallback((e) => {
    if (isReadTrack) return
    e.preventDefault()
    e.stopPropagation()
    window.dispatchEvent(new CustomEvent('bingo-region-context', { detail: { x: e.clientX, y: e.clientY } }))
  }, [isReadTrack])

  // Early exit — nothing to render
  if (!region || !hasSelection && !hasOverlays) return null

  const regionLen = region.end - region.start
  if (regionLen <= 0) return null
  const toX = (pos) => ((pos - region.start) / regionLen) * width

  // Selection highlight pixels
  let selPxLeft = 0, selPxWidth = 0
  if (hasSelection) {
    selPxLeft = Math.max(0, toX(selection.start))
    selPxWidth = Math.min(width, toX(selection.end)) - selPxLeft
    if (selPxWidth < 1) selPxWidth = 0
  }

  const shouldShowTip = (hover || autoShow) && selPxWidth > 0
  // Only compute stats when the tooltip is actually visible
  const stats = shouldShowTip ? computeStats(selection, trackData, trackType, sigRow) : []
  const selLen = selection ? selection.end - selection.start : 0
  const tipWidth = 260

  // Position the tooltip near the cursor when hovering. When auto-showing
  // immediately after a fresh selection (cursor hasn't moved over the
  // highlight yet), anchor it to the top-centre of the highlight instead
  // — that way the tooltip is visible even if the mouse is still resting.
  let tipX, tipY
  if (hover) {
    tipX = Math.min(mousePos.x + 14, window.innerWidth - tipWidth - 10)
    tipY = Math.min(mousePos.y + 14, window.innerHeight - 200)
  } else if (autoShow && overlayRef.current) {
    const rect = overlayRef.current.getBoundingClientRect()
    tipX = Math.max(8, Math.min(
      rect.left + selPxLeft + selPxWidth / 2 - tipWidth / 2,
      window.innerWidth - tipWidth - 10,
    ))
    tipY = Math.min(rect.top + height + 6, window.innerHeight - 200)
  } else {
    tipX = 0; tipY = 0
  }

  return (
    <div ref={overlayRef} style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none' }}>
      {/* Persistent region highlight overlays */}
      {hasOverlays && regionOverlays.map((o, i) => {
        if (!o.highlightColor || o.chrom !== region.chrom) return null
        const ox = Math.max(0, toX(o.start))
        const ow = Math.min(width, toX(o.end)) - ox
        if (ow < 1) return null
        return <div key={i} style={{
          position: 'absolute', left: ox, top: 0, width: ow, height: '100%',
          background: o.highlightColor, opacity: o.highlightOpacity || 0.35, pointerEvents: 'none',
        }} />
      })}

      {/* Selection highlight */}
      {selPxWidth > 0 && (
        <div style={{
          position: 'absolute', left: selPxLeft, top: 0, width: selPxWidth, height: '100%',
          background: 'rgba(100, 181, 246, 0.2)',
          borderLeft: '1px solid rgba(100, 181, 246, 0.6)',
          borderRight: '1px solid rgba(100, 181, 246, 0.6)',
          pointerEvents: 'auto', cursor: 'crosshair',
          // Stay above the canvas defensively — both elements default to
          // z-index auto and DOM order alone is usually enough, but this
          // guarantees the highlight wins hit-testing for hover regardless
          // of any stacking context introduced elsewhere.
          zIndex: 5,
        }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          onClick={(e) => { e.stopPropagation(); clearSelection() }}
          onContextMenu={onContextMenu}
        />
      )}

      {/* Tooltip — on hover, or briefly after a fresh selection */}
      {shouldShowTip && createPortal(
        <div style={{
          position: 'fixed', left: tipX, top: tipY,
          background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
          borderRadius: 6, padding: '8px 12px', fontSize: 11,
          color: theme.textPrimary, lineHeight: 1.6,
          pointerEvents: 'none', zIndex: 10000,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', minWidth: 180, maxWidth: tipWidth,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Selected Region</div>
          <div><span style={{ color: theme.textSecondary }}>Region:</span> {selection.chrom}:{selection.start.toLocaleString()}-{selection.end.toLocaleString()}</div>
          <div><span style={{ color: theme.textSecondary }}>Length:</span> {selLen.toLocaleString()} bp</div>
          {stats.map((s, i) => (
            <div key={i}><span style={{ color: theme.textSecondary }}>{s.label}:</span> {s.value}</div>
          ))}
          <div style={{ fontSize: 9, color: theme.textTertiary, marginTop: 4 }}>
            Click to dismiss{!isReadTrack ? ' \u00b7 Right-click for region colors' : ''}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

/** Tooltip rows. `sig` is the exact /stats row for coverage/read tracks
 *  (undefined while loading, null if unavailable). */
function computeStats(selection, trackData, trackType, sig) {
  const stats = []
  if (!selection) return stats
  if (trackType === 'reads' && trackData?.reads) {
    const reads = trackData.reads.filter(r => r.end > selection.start && r.start < selection.end)
    // A downsampled read view holds only a sample of the reads.
    stats.push(trackData.truncated
      ? { label: 'Reads shown', value: `${reads.length.toLocaleString()} (downsampled view)` }
      : { label: 'Reads', value: reads.length.toLocaleString() })
  }
  if (trackType === 'coverage' || trackType === 'reads') {
    const len = selection.end - selection.start
    if (sig === undefined) {
      stats.push({ label: 'Signal', value: 'loading…' })
    } else if (sig && !sig.complete) {
      stats.push({ label: 'Signal', value: 'computing exact coverage…' })
    } else if (sig && sig.covered > 0) {
      if (sig.strand) {
        stats.push({ label: 'Sum', value: `+${formatValue(sig.fwdSum)} / −${formatValue(Math.abs(sig.revSum))}` })
        stats.push({ label: 'Max', value: `+${formatValue(sig.max)} / −${formatValue(Math.abs(sig.min))}` })
      } else {
        stats.push({ label: 'Mean', value: formatValue(sig.mean) })
        stats.push({ label: sig.min < 0 ? 'Max / min' : 'Max', value: sig.min < 0 ? `${formatValue(sig.max)} / ${formatValue(sig.min)}` : formatValue(sig.max) })
        stats.push({ label: 'Sum', value: formatValue(sig.sum) })
      }
      if (sig.covered < len) stats.push({ label: 'Data on', value: `${sig.covered.toLocaleString()} of ${len.toLocaleString()} bp` })
    } else if (sig) {
      stats.push({ label: 'Signal', value: 'no data' })
    }
  }
  if (!trackData) return stats
  if (trackType === 'variants' && trackData.variants) stats.push({ label: 'Variants', value: trackData.variants.filter(v => v.pos >= selection.start && v.pos < selection.end).length.toLocaleString() })
  if ((trackType === 'annotations' || trackType === 'genome_annotations') && trackData.features) stats.push({ label: 'Features', value: trackData.features.filter(f => f.end > selection.start && f.start < selection.end).length.toLocaleString() })
  return stats
}
