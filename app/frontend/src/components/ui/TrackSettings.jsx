/**
 * TrackSettings.jsx — Bulk track configuration panel.
 *
 * Allows adjusting visibility, height, color, scale (linear/log),
 * Y-axis range, coverage bin size and windowing, and bar width for
 * selected tracks.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTracks, DEFAULT_ANNOTATION_COLORS, makeGroupId } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'
import { useBrowser } from '../../store/BrowserContext'
import { getLiveTrackData, useLiveDataVersion, computeAutoScale, needsSplitLayout, scaleGroup, READ_DETAIL_THRESHOLD } from '../../hooks/useTrackData'
import { formatBp, formatValue, coverageAxis } from '../../utils/coverageStats'
import { MAX_BINS } from '../../utils/fetchPlan'
import DraggablePanel from './DraggablePanel'
import NumberInput from './NumberInput'

// Fixed coverage bin sizes offered under Bin size (bp); Auto = ~1 bin per pixel.
const BIN_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

/** Round up to `digits` significant figures (5577 → 5580, 0.01234 → 0.0124). */
function ceilSig(v, digits = 3) {
  if (!(v > 0)) return 0
  const p = Math.pow(10, Math.floor(Math.log10(v)) - (digits - 1))
  return Number((Math.ceil(v / p - 1e-9) * p).toPrecision(digits + 1))
}

/** The fixed scale for an axis drawn at `v`: the shortest number >= v whose
 *  axis label reads the same (5576.96 → 5577, 8.11523 → 8.1153, 30.9 → 30.9),
 *  so fixing the scale changes neither the picture nor the label and never
 *  clips the peak the axis was fitted to. */
function scaleAt(v) {
  const label = formatValue(v)
  for (let digits = 1; digits <= 15; digits++) {
    const c = ceilSig(v, digits)
    if (c >= v && formatValue(c) === label) return c
  }
  return v
}

/** "now 864 bp" — the bin width currently drawn, from the tracks' live data. */
function binNowLabel(binNow) {
  const sizes = binNow.filter(b => !b.reads).map(b => b.eff)
  if (!sizes.length) return binNow.length ? 'individual reads at this zoom' : ''
  const lo = Math.min(...sizes), hi = Math.max(...sizes)
  const fmt = v => (Number.isInteger(v) ? '' : '≈') + formatBp(v)
  return lo === hi ? `now ${fmt(lo)}` : `now ${fmt(lo)}–${formatBp(hi)}`
}

// Ordered by hue: reds → oranges → yellows → greens → cyans → blues → purples → grays
const ORDERED_COLORS = [
  '#f44336', '#e53935', '#ef5350', '#e57373',
  '#ff5722', '#ff8a65', '#ff9800', '#ffa726', '#ffb74d',
  '#ffc107', '#ffd54f', '#fff176',
  '#4caf50', '#66bb6a', '#81c784', '#aed581',
  '#009688', '#26c6da', '#4dd0e1', '#80cbc4',
  '#2196f3', '#42a5f5', '#64b5f6',
  '#3f51b5', '#7e57c2', '#9575cd',
  '#9c27b0', '#ab47bc', '#ce93d8',
  '#e91e63', '#f06292',
  '#795548', '#8d6e63',
  '#607d8b', '#78909c',
]

export default function TrackSettings({ onClose }) {
  const { theme } = useTheme()
  const { region } = useBrowser()
  const { tracks, updateTrack, updateMultipleTracks, removeTrack, createOverlayGroup, dissolveOverlayGroup } = useTracks()
  const [selected, setSelected] = useState(new Set())
  const [customBin, setCustomBin] = useState(false)
  useEffect(() => { setCustomBin(false) }, [selected])
  // Selected tracks that the last untick of Auto left on Auto (fixScaleAtCurrent).
  const [keptAuto, setKeptAuto] = useState([])
  useEffect(() => { setKeptAuto([]) }, [selected])

  function toggle(id) {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function selectAll() { setSelected(new Set(tracks.map(t => t.id))) }
  function selectNone() { setSelected(new Set()) }

  const selectedTracks = tracks.filter(t => selected.has(t.id))
  const hasAnnotation = selectedTracks.some(t => t.track_type === 'annotations' || t.track_type === 'genome_annotations')
  const hasCoverage = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads')
  const hasReads = selectedTracks.some(t => t.track_type === 'reads')
  const hasVariants = selectedTracks.some(t => t.track_type === 'variants')
  const hasBars = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads' || t.track_type === 'variants')
  const hasCoverageBars = selectedTracks.some(t => t.track_type === 'coverage' || t.track_type === 'reads')

  // Overlay groups (coverage tracks only). When ≥2 coverage tracks are selected
  // they can be merged into one overlaid row; when the selection is exactly one
  // existing group, offer to separate it.
  const coverageSelected = selectedTracks.filter(t => t.track_type === 'coverage')
  const coverageIds = coverageSelected.map(t => t.id)
  const sharedOverlayGroup = coverageSelected.length >= 2 &&
    coverageSelected.every(t => t.overlayGroup && t.overlayGroup === coverageSelected[0].overlayGroup)
      ? coverageSelected[0].overlayGroup : null

  const commonHeight = selectedTracks.length > 0 && selectedTracks.every(t => t.height === selectedTracks[0].height) ? selectedTracks[0].height : ''
  const commonAutoHeight = selectedTracks.length > 0 && selectedTracks.every(t => (t.autoHeight !== false) === (selectedTracks[0].autoHeight !== false)) ? (selectedTracks[0].autoHeight !== false) : null
  // Only reads + annotation tracks stack rows, so auto-fit only matters there.
  const hasRowStacked = selectedTracks.some(t => t.track_type === 'reads' || t.track_type === 'annotations' || t.track_type === 'genome_annotations')
  const commonColor = selectedTracks.length > 0 && selectedTracks.every(t => t.color === selectedTracks[0].color) ? selectedTracks[0].color : '#888888'
  const commonVisible = selectedTracks.length > 0 && selectedTracks.every(t => t.visible === selectedTracks[0].visible) ? selectedTracks[0].visible : null
  const commonArrows = selectedTracks.length > 0 && selectedTracks.every(t => t.useArrows === selectedTracks[0].useArrows) ? selectedTracks[0].useArrows : null
  // Scale, bin size and windowing apply to coverage-like tracks (coverage and
  // BAM reads) only; their "common" values ignore the rest of the selection.
  // commonOf → the shared value, or null when the selected tracks differ.
  const coverageLike = selectedTracks.filter(t => t.track_type === 'coverage' || t.track_type === 'reads')
  const coverageLikeIds = coverageLike.map(t => t.id)
  const commonOf = (list, f) => list.length > 0 && list.every(x => f(x) === f(list[0])) ? f(list[0]) : null
  const commonAutoScale = commonOf(coverageLike, t => t.scaleMax == null && t.scaleMin == null)
  const commonScaleMax = commonOf(coverageLike, t => t.scaleMax ?? null)
  const commonScaleMin = commonOf(coverageLike, t => t.scaleMin ?? null)
  const commonAutoScaleVisible = commonOf(coverageLike, t => t.autoScaleVisible !== false)
  const commonLinked = commonOf(coverageLike, t => t.linkScale || false)   // shared link id, false, or null
  const showLink = coverageLike.length > 1 || coverageLike.some(t => t.linkScale)
  const commonWindowing = commonOf(coverageLike, t => (t.windowing === 'mean' ? 'mean' : 'max'))
  const commonBinSize = commonOf(coverageLike, t => (t.binSize > 0 ? t.binSize : 0))   // 0 = auto

  // The bins drawn right now, per selected track (re-rendered as data arrives,
  // so the readout follows the zoom).
  useLiveDataVersion(coverageLike.length > 0)
  const binNow = coverageLike.map(tr => {
    const d = getLiveTrackData(tr.id)
    if (!d || (region && d.chrom && d.chrom !== region.chrom)) return null
    if (d.mode === 'reads') return { reads: true }
    const eff = d.plan?.binSize ?? d.bin_size
    return eff > 0 ? { eff, capped: d.plan?.capped === true } : null
  }).filter(Boolean)
  const binCapped = binNow.some(b => b.capped)
  const binIsCustom = customBin || (commonBinSize > 0 && !BIN_PRESETS.includes(commonBinSize))
  const binSelectValue = commonBinSize === null && !customBin ? ''
    : binIsCustom ? 'custom' : commonBinSize === 0 ? 'auto' : String(commonBinSize)

  const commonLogScale = selectedTracks.length > 0 && selectedTracks.every(t => t.logScale === selectedTracks[0].logScale) ? selectedTracks[0].logScale : null
  const commonBarAutoWidth = selectedTracks.length > 0 && selectedTracks.every(t => t.barAutoWidth === selectedTracks[0].barAutoWidth) ? selectedTracks[0].barAutoWidth : null
  const commonBarWidth = selectedTracks.length > 0 && selectedTracks.every(t => t.barWidth === selectedTracks[0].barWidth) ? selectedTracks[0].barWidth : undefined
  const commonShowOutline = selectedTracks.length > 0 && selectedTracks.every(t => t.showOutline === selectedTracks[0].showOutline) ? selectedTracks[0].showOutline : null
  const commonOutlineColor = selectedTracks.length > 0 && selectedTracks.every(t => t.outlineColor === selectedTracks[0].outlineColor) ? selectedTracks[0].outlineColor : undefined
  const commonOutlineSmooth = selectedTracks.length > 0 && selectedTracks.every(t => t.outlineSmooth === selectedTracks[0].outlineSmooth) ? selectedTracks[0].outlineSmooth : undefined
  const commonShowBars = selectedTracks.length > 0 && selectedTracks.every(t => t.showBars === selectedTracks[0].showBars) ? selectedTracks[0].showBars : null
  const commonFillArea = selectedTracks.length > 0 && selectedTracks.every(t => (t.fillArea === true) === (selectedTracks[0].fillArea === true)) ? (selectedTracks[0].fillArea === true) : null
  const commonShowNucleotides = selectedTracks.length > 0 && selectedTracks.every(t => t.showNucleotides === selectedTracks[0].showNucleotides) ? selectedTracks[0].showNucleotides : null
  const commonFwdColor = selectedTracks.length > 0 && selectedTracks.every(t => (t.fwdColor || '#90a4ae') === (selectedTracks[0].fwdColor || '#90a4ae')) ? (selectedTracks[0].fwdColor || '#90a4ae') : undefined
  const commonRevColor = selectedTracks.length > 0 && selectedTracks.every(t => (t.revColor || '#f06292') === (selectedTracks[0].revColor || '#f06292')) ? (selectedTracks[0].revColor || '#f06292') : undefined
  const commonArrowStyle = selectedTracks.length > 0 && selectedTracks.every(t => (t.arrowStyle || 'pointed') === (selectedTracks[0].arrowStyle || 'pointed')) ? (selectedTracks[0].arrowStyle || 'pointed') : undefined
  const commonArrowSize = selectedTracks.length > 0 && selectedTracks.every(t => (t.arrowSize || 4) === (selectedTracks[0].arrowSize || 4)) ? (selectedTracks[0].arrowSize || 4) : undefined
  const commonShowFwd = selectedTracks.length > 0 && selectedTracks.every(t => (t.showFwdStrand !== false) === (selectedTracks[0].showFwdStrand !== false)) ? (selectedTracks[0].showFwdStrand !== false) : null
  const commonShowRev = selectedTracks.length > 0 && selectedTracks.every(t => (t.showRevStrand !== false) === (selectedTracks[0].showRevStrand !== false)) ? (selectedTracks[0].showRevStrand !== false) : null

  function applyToSelected(updates) { updateMultipleTracks([...selected], updates) }
  function applyToCoverage(updates) { updateMultipleTracks(coverageLikeIds, updates) }
  function removeSelected() { for (const id of selected) removeTrack(id); setSelected(new Set()) }

  /** The track whose axis `tr` shows: an overlay row's base layer (its first
   *  member drawn here), otherwise the track itself; null when `tr` is not
   *  drawn on this chromosome (hidden, or no data on it). */
  function axisRef(tr) {
    const chrom = region?.chrom
    const shown = m => m.visible !== false && (!m.targetChromosomes || !chrom || m.targetChromosomes.includes(chrom))
    const ref = (tr.overlayGroup && tracks.find(m => m.overlayGroup === tr.overlayGroup && shown(m))) || tr
    return shown(ref) ? ref : null
  }

  /** True when the axis `ref` draws comes only from live data for this view:
   *  every track sharing it (scaleGroup) holds data for this chromosome
   *  fetched over a range containing [region.start, region.end). A hidden
   *  track's frozen data, another view's, or a fetch still on its way never
   *  counts. A read track showing reads at this zoom is the exception: it adds
   *  no bins to the axis before its fetch lands or after, so its reads for
   *  the previous view are as good as the new ones. */
  function axisIsCurrent(ref) {
    if (!region) return false
    const readView = region.end - region.start <= READ_DETAIL_THRESHOLD
    return scaleGroup(ref, region, tracks).every(m => {
      const d = getLiveTrackData(m.id)
      if (!d || (d.chrom && d.chrom !== region.chrom)) return false
      if (m.track_type === 'reads' && readView && !d.bins) return true
      return d.start <= region.start && d.end >= region.end
    })
  }

  // Of the tracks the last untick left on Auto, those still on Auto and still
  // not on screen (the hint under Y Scale counts them).
  const keptAutoNow = keptAuto.filter(id => {
    const tr = coverageLike.find(t => t.id === id)
    if (!tr || tr.scaleMax != null || tr.scaleMin != null) return false
    const ref = axisRef(tr)
    return !ref || !axisIsCurrent(ref)
  }).length

  /** Turn Auto off at the axis each track draws now, so neither the picture
   *  nor its labels change (the old fixed 100/100 start rarely suited the
   *  data). The axis comes from the renderers' own rule (coverageAxis): linked
   *  and overlaid tracks share their group's axis, so they get the same
   *  values, and a track drawn only as a smoothed curve gets the curve's.
   *  Only an axis drawn from data for this view is fixed: a track that is not
   *  on screen (hidden, not on this chromosome, not loaded yet) keeps Auto,
   *  and the panel says so. */
  function fixScaleAtCurrent() {
    const kept = []
    for (const tr of coverageLike) {
      const ref = axisRef(tr)
      if (!ref || !axisIsCurrent(ref)) { kept.push(tr.id); continue }
      const auto = computeAutoScale(ref, region, tracks)
      const d = getLiveTrackData(ref.id)
      const bins = d.bins?.length ? d.bins : null
      let up = auto.max > 0 ? auto.max : 100   // individual reads: no axis is drawn
      let down = null
      if (bins) {
        // A read track's coverage view never uses the split layout (ReadTrack).
        const split = ref.track_type !== 'reads' && needsSplitLayout(ref, region, tracks)
        const axis = coverageAxis(ref, bins, region, { auto, split, grouped: !!(ref.overlayGroup || ref.linkScale) })
        up = axis.max
        if (split) down = axis.min
      }
      if (down == null) down = auto.min < 0 ? -auto.min : up
      updateTrack(tr.id, { scaleMax: scaleAt(up), scaleMin: scaleAt(down) })
    }
    setKeptAuto(kept)
  }

  function onBinSelect(v) {
    if (v === 'auto') { setCustomBin(false); applyToCoverage({ binSize: null }) }
    else if (v === 'custom') {
      setCustomBin(true)
      // Start the custom size at what is drawn now, so nothing jumps.
      if (!(commonBinSize > 0)) {
        const sizes = binNow.filter(b => !b.reads).map(b => b.eff)
        applyToCoverage({ binSize: sizes.length ? Math.max(1, Math.round(Math.max(...sizes))) : 100 })
      }
    } else if (v) { setCustomBin(false); applyToCoverage({ binSize: parseInt(v, 10) }) }
  }

  const t = theme
  const S = {
    body: { padding: '8px 0', overflowY: 'auto', flex: 1 },
    trackRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 16px', cursor: 'pointer', transition: 'background 0.1s' },
    trackRowSelected: { background: t.selectedRow },
    checkbox: { width: 14, height: 14, cursor: 'pointer', flexShrink: 0 },
    trackLabel: { fontSize: 12, color: t.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    trackType: { fontSize: 10, color: t.textTertiary, flexShrink: 0 },
    section: { padding: '12px 16px', borderTop: `1px solid ${t.border}` },
    sectionTitle: { fontSize: 11, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
    controlRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
    subRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, paddingLeft: 16, borderLeft: `2px solid ${t.border}`, marginLeft: 4 },
    controlLabel: { fontSize: 12, color: t.textSecondary, width: 90 },
    subLabel: { fontSize: 11, color: t.textTertiary, width: 76 },
    input: { background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '3px 6px', fontSize: 12, width: 70 },
    colorInput: { width: 28, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 },
    btn: { background: t.btnBg, border: 'none', borderRadius: 4, color: t.btnText, padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    btnDanger: { background: t.btnDanger, border: 'none', borderRadius: 4, color: '#fff', padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: `1px solid ${t.border}`, gap: 8 },
    smallBtn: { background: 'none', border: `1px solid ${t.borderAccent}`, borderRadius: 3, color: t.textSecondary, cursor: 'pointer', fontSize: 10, padding: '2px 8px' },
    cbLabel: { fontSize: 12, color: t.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 },
    select: { background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '2px 6px', fontSize: 11, cursor: 'pointer' },
    hint: { fontSize: 10, color: t.textTertiary, lineHeight: 1.4 },
  }

  return (
    <DraggablePanel title="Track Settings" onClose={onClose} theme={t} defaultWidth={460} defaultHeight={520}>
        <div style={S.body}>
          {tracks.length === 0 ? (
            <div style={{ padding: 16, color: t.textTertiary, fontSize: 12 }}>No tracks loaded.</div>
          ) : tracks.map(tr => (
            <div key={tr.id} style={{ ...S.trackRow, ...(selected.has(tr.id) ? S.trackRowSelected : {}) }} onClick={() => toggle(tr.id)}>
              <input type="checkbox" checked={selected.has(tr.id)} onChange={() => toggle(tr.id)} onClick={e => e.stopPropagation()} style={S.checkbox} />
              <span style={{ width: 10, height: 10, borderRadius: 2, background: tr.color, flexShrink: 0 }} />
              <span style={{ ...S.trackLabel, opacity: tr.visible ? 1 : 0.4 }}>{tr.name}</span>
              <span style={S.trackType}>{tr.track_type}</span>
            </div>
          ))}
        </div>

        {selectedTracks.length > 0 && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Edit {selectedTracks.length} selected track{selectedTracks.length > 1 ? 's' : ''}</div>

            {/* 1. Height — a manual change turns auto-fit OFF so the value sticks */}
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Height (px)</span>
              <input type="range" min={30} max={500} step={1} value={commonHeight || 80}
                onChange={e => applyToSelected({ height: parseInt(e.target.value), autoHeight: false })}
                style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
              <NumberInput value={commonHeight === '' ? null : commonHeight}
                onCommit={v => { if (v != null) applyToSelected({ height: v, autoHeight: false }) }}
                min={30} max={500} integer placeholder="mixed" style={{ ...S.input, width: 48 }} />
            </div>
            {/* Auto-fit height (reads + annotation tracks stack rows) */}
            {hasRowStacked && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Auto height</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonAutoHeight === true}
                    ref={el => { if (el) el.indeterminate = commonAutoHeight === null }}
                    onChange={e => applyToSelected({ autoHeight: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Fit to show all rows
                </label>
              </div>
            )}

            {/* 2. Visible */}
            <div style={S.controlRow}>
              <span style={S.controlLabel}>Visible</span>
              <label style={S.cbLabel}>
                <input type="checkbox" checked={commonVisible === true}
                  ref={el => { if (el) el.indeterminate = commonVisible === null }}
                  onChange={e => applyToSelected({ visible: e.target.checked })} style={{ cursor: 'pointer' }} />
                Show
              </label>
            </div>

            {/* 3. Fill bars + color (coverage/read tracks only, not variants) */}
            {hasCoverageBars && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Fill bars</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonShowBars !== false}
                    ref={el => { if (el) el.indeterminate = commonShowBars === null }}
                    onChange={e => applyToSelected({ showBars: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Show
                </label>
                {commonShowBars !== false && (
                  <ColorHexInput value={commonColor} onChange={v => applyToSelected({ color: v })} theme={t} />
                )}
              </div>
            )}

            {/* Color for variant and other non-coverage, non-annotation tracks */}
            {(hasVariants || (!hasBars && !hasAnnotation)) && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Color</span>
                <ColorHexInput value={commonColor} onChange={v => applyToSelected({ color: v })} theme={t} />
              </div>
            )}

            {/* 4. Bar width (bar tracks only) */}
            {hasBars && (
              <>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Bar width</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonBarAutoWidth !== false}
                      ref={el => { if (el) el.indeterminate = commonBarAutoWidth === null }}
                      onChange={e => applyToSelected({ barAutoWidth: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    Auto
                  </label>
                </div>
                {commonBarAutoWidth === false && (
                  <div style={S.subRow}>
                    <span style={S.subLabel}>Width</span>
                    <input type="range" min={1} max={50} step={1} value={commonBarWidth ?? 2}
                      onChange={e => applyToSelected({ barWidth: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <NumberInput value={commonBarWidth ?? 2} onCommit={v => { if (v != null) applyToSelected({ barWidth: v }) }}
                      min={1} max={50} integer style={{ ...S.input, width: 48 }} />
                    <span style={{ fontSize: 11, color: t.textTertiary }}>px</span>
                  </div>
                )}
              </>
            )}

            {/* 5. Peak outline (coverage/read tracks only, not variants) */}
            {hasCoverageBars && (
              <>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Peak outline</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonShowOutline === true}
                      ref={el => { if (el) el.indeterminate = commonShowOutline === null }}
                      onChange={e => applyToSelected({ showOutline: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    Trace peaks
                  </label>
                  {commonShowOutline === true && (
                    <ColorHexInput value={commonOutlineColor || commonColor || '#ffffff'} onChange={v => applyToSelected({ outlineColor: v })} theme={t} />
                  )}
                </div>
                {commonShowOutline === true && (
                  <div style={S.subRow}>
                    <span style={S.subLabel}>Smoothness</span>
                    <input type="range" min={0} max={10} step={1} value={commonOutlineSmooth ?? 0}
                      onChange={e => applyToSelected({ outlineSmooth: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 24, textAlign: 'right' }}>{commonOutlineSmooth ?? 0}</span>
                  </div>
                )}
                {/* Smooth fill: fill the area under the (smoothed) outline curve
                    with a single colour in place of the bars. */}
                {commonShowOutline === true && (
                  <div style={S.subRow}>
                    <span style={S.subLabel}>Smooth fill</span>
                    <label style={S.cbLabel}>
                      <input type="checkbox" checked={commonFillArea === true}
                        ref={el => { if (el) el.indeterminate = commonFillArea === null }}
                        onChange={e => applyToSelected({ fillArea: e.target.checked })}
                        style={{ cursor: 'pointer' }} />
                      Fill under curve (instead of bars)
                    </label>
                  </div>
                )}
              </>
            )}

            {/* 6. Bin size (coverage/read tracks) — Auto keeps ~one bin per
                screen pixel; a fixed size gives genome-aligned bins of that
                width at every zoom. The readout shows the bins drawn now. */}
            {hasCoverage && (
              <div style={S.controlRow}>
                <span style={S.controlLabel} title="Width of each coverage bin. Auto uses about one bin per screen pixel.">Bin size</span>
                <select value={binSelectValue} onChange={e => onBinSelect(e.target.value)} style={S.select}>
                  {binSelectValue === '' && <option value="" disabled>Mixed</option>}
                  <option value="auto">Auto</option>
                  {BIN_PRESETS.map(b => <option key={b} value={String(b)}>{formatBp(b)}</option>)}
                  <option value="custom">Custom{'…'}</option>
                </select>
                <span style={{ fontSize: 11, color: t.textTertiary }}>{binNowLabel(binNow)}</span>
              </div>
            )}
            {hasCoverage && binIsCustom && (
              <div style={S.subRow}>
                <span style={S.subLabel}>Custom</span>
                <NumberInput value={commonBinSize > 0 ? commonBinSize : null}
                  onCommit={v => { if (v != null) applyToCoverage({ binSize: v }) }}
                  min={1} max={10000000} integer placeholder="bp" style={S.input} />
                <span style={{ fontSize: 11, color: t.textTertiary }}>bp</span>
              </div>
            )}
            {hasCoverage && binCapped && (
              <div style={S.subRow}>
                <span style={S.hint}>
                  Coarsened at this zoom: at most {MAX_BINS.toLocaleString()} bins are drawn per view.
                </span>
              </div>
            )}

            {/* 7. Windowing — what a bin shows when it spans many bases */}
            {hasCoverage && (
              <div style={S.controlRow}>
                <span style={S.controlLabel} title="How each bin summarises the bases it spans when zoomed out">Windowing</span>
                <select value={commonWindowing ?? ''} onChange={e => { if (e.target.value) applyToCoverage({ windowing: e.target.value }) }} style={S.select}>
                  {commonWindowing === null && <option value="" disabled>Mixed</option>}
                  <option value="max">Max (keeps peak heights)</option>
                  <option value="mean">Mean (average per bin)</option>
                </select>
              </div>
            )}

            {/* 8. Y Scale (coverage/read tracks). Unticking Auto fixes the axis
                where it is now; a mixed selection shows indeterminate. */}
            {hasCoverage && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Y Scale</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonAutoScale === true}
                    ref={el => { if (el) el.indeterminate = commonAutoScale === null }}
                    onChange={e => {
                      if (e.target.checked) { setKeptAuto([]); applyToCoverage({ scaleMax: null, scaleMin: null }) }
                      else fixScaleAtCurrent()
                    }}
                    style={{ cursor: 'pointer' }} />
                  Auto
                </label>
                {commonAutoScale === null && <span style={S.hint}>mixed {'—'} tick to make all auto</span>}
              </div>
            )}
            {/* Unticking Auto fixes only axes drawn for this view. */}
            {hasCoverage && keptAutoNow > 0 && (
              <div style={S.subRow}>
                <span style={S.hint}>
                  {keptAutoNow} selected track{keptAutoNow > 1 ? 's' : ''} not on screen or still loading keep{keptAutoNow > 1 ? '' : 's'} Auto
                </span>
              </div>
            )}
            {/* Fit to the visible region (default) — off fits the whole fetched
                range, which also includes data just off-screen. */}
            {hasCoverage && commonAutoScale === true && (
              <div style={S.subRow}>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonAutoScaleVisible === true}
                    ref={el => { if (el) el.indeterminate = commonAutoScaleVisible === null }}
                    onChange={e => applyToCoverage({ autoScaleVisible: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Fit to visible region
                </label>
                <span style={S.hint}>(off: also fits data just off-screen)</span>
              </div>
            )}
            {/* Link the auto scale: every tick creates a new link group, so
                separate sets of tracks can each share their own axis. */}
            {hasCoverage && commonAutoScale === true && showLink && (
              <div style={S.subRow}>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={!!commonLinked}
                    ref={el => { if (el) el.indeterminate = commonLinked === null }}
                    onChange={e => applyToCoverage({ linkScale: e.target.checked ? makeGroupId('lnk') : false })}
                    style={{ cursor: 'pointer' }} />
                  {coverageLike.length > 1 ? 'Link scales across selected tracks' : 'Linked scale (untick to unlink)'}
                </label>
              </div>
            )}
            {hasCoverage && commonAutoScale === false && (
              <div style={S.subRow}>
                <span style={{ fontSize: 11, color: t.textTertiary, width: 40 }}>+Ymax</span>
                <NumberInput value={commonScaleMax}
                  onCommit={v => { if (v != null) applyToCoverage({ scaleMax: v }) }}
                  min={0} validate={v => v > 0} integer={false} placeholder="mixed" style={S.input} />
                <span style={{ fontSize: 11, color: t.textTertiary, width: 40 }}>{'−'}Ymax</span>
                <NumberInput value={commonScaleMin}
                  onCommit={v => { if (v != null) applyToCoverage({ scaleMin: v }) }}
                  min={0} validate={v => v > 0} integer={false} placeholder="mixed" style={S.input} />
              </div>
            )}

            {/* 9. Log2 (coverage tracks only) */}
            {hasCoverage && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Log scale</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonLogScale === true}
                    ref={el => { if (el) el.indeterminate = commonLogScale === null }}
                    onChange={e => applyToSelected({ logScale: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  log{'\u2082'}
                </label>
              </div>
            )}

            {/* Overlay coverage tracks into one shared, transparent row */}
            {coverageSelected.length >= 2 && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Overlay</span>
                {sharedOverlayGroup ? (
                  <button style={S.smallBtn} onClick={() => dissolveOverlayGroup(sharedOverlayGroup)}>
                    Separate overlay
                  </button>
                ) : (
                  <button style={S.smallBtn} onClick={() => createOverlayGroup(coverageIds)}>
                    Overlay these {coverageSelected.length} tracks
                  </button>
                )}
                <span style={{ fontSize: 10, color: t.textTertiary }}>
                  {sharedOverlayGroup ? 'Currently overlaid' : 'Stack on one axis'}
                </span>
              </div>
            )}
            {coverageSelected.length >= 2 && !sharedOverlayGroup && (
              <div style={{ ...S.subRow, borderLeft: 'none', marginLeft: 0, paddingLeft: 90 }}>
                <span style={{ fontSize: 10, color: t.textTertiary, lineHeight: 1.4 }}>
                  Tune each track's color, transparency and stacking order in the
                  overlay row's legend on the left.
                </span>
              </div>
            )}

            {/* ── Type-specific sections ────────────────────── */}

            {/* Annotation colors */}
            {hasAnnotation && (
              <AnnotationColorSection tracks={selectedTracks} applyToSelected={applyToSelected} theme={t} />
            )}

            {/* Feature type visibility (GenBank / annotation tracks) */}
            {hasAnnotation && (
              <FeatureTypeSection tracks={selectedTracks} applyToSelected={applyToSelected} theme={t} />
            )}

            {/* Gene style */}
            {hasAnnotation && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Gene style</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonArrows === true}
                    ref={el => { if (el) el.indeterminate = commonArrows === null }}
                    onChange={e => applyToSelected({ useArrows: e.target.checked })} style={{ cursor: 'pointer' }} />
                  Pointed arrows
                </label>
              </div>
            )}

            {/* Nucleotides */}
            {(hasReads || hasAnnotation) && (
              <div style={S.controlRow}>
                <span style={S.controlLabel}>Nucleotides</span>
                <label style={S.cbLabel}>
                  <input type="checkbox" checked={commonShowNucleotides !== false}
                    ref={el => { if (el) el.indeterminate = commonShowNucleotides === null }}
                    onChange={e => applyToSelected({ showNucleotides: e.target.checked })}
                    style={{ cursor: 'pointer' }} />
                  Show when zoomed in
                </label>
              </div>
            )}

            {/* Read Appearance */}
            {hasReads && (
              <>
                <div style={{ ...S.sectionTitle, marginTop: 12 }}>Read Appearance</div>
                {/* Strand visibility */}
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Show strand</span>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonShowFwd === true}
                      ref={el => { if (el) el.indeterminate = commonShowFwd === null }}
                      onChange={e => applyToSelected({ showFwdStrand: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    {'\u25B6'} Forward
                  </label>
                  <label style={S.cbLabel}>
                    <input type="checkbox" checked={commonShowRev === true}
                      ref={el => { if (el) el.indeterminate = commonShowRev === null }}
                      onChange={e => applyToSelected({ showRevStrand: e.target.checked })}
                      style={{ cursor: 'pointer' }} />
                    {'\u25C0'} Reverse
                  </label>
                </div>
                {/* Strand colors */}
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Strand colors</span>
                  <span style={{ fontSize: 10, color: t.textTertiary, marginRight: 2 }}>{'\u25B6'}</span>
                  <SwatchColorPicker value={commonFwdColor || '#90a4ae'} onChange={v => applyToSelected({ fwdColor: v })} theme={t} />
                  <span style={{ fontSize: 10, color: t.textTertiary, marginLeft: 4, marginRight: 2 }}>{'\u25C0'}</span>
                  <SwatchColorPicker value={commonRevColor || '#f06292'} onChange={v => applyToSelected({ revColor: v })} theme={t} />
                  <button style={{ ...S.smallBtn, marginLeft: 'auto' }}
                    onClick={() => applyToSelected({ fwdColor: null, revColor: null })}
                    title="Reset to defaults"
                  >Reset</button>
                </div>
                <div style={S.controlRow}>
                  <span style={S.controlLabel}>Arrow style</span>
                  <select value={commonArrowStyle || 'pointed'}
                    onChange={e => applyToSelected({ arrowStyle: e.target.value })}
                    style={{ background: t.inputBg, border: `1px solid ${t.borderAccent}`, borderRadius: 4, color: t.textPrimary, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}>
                    <option value="pointed">Pointed</option>
                    <option value="chevron">Chevron</option>
                    <option value="fade">Fade</option>
                    <option value="flat">Flat (none)</option>
                  </select>
                </div>
                {(commonArrowStyle || 'pointed') !== 'flat' && (
                  <div style={S.subRow}>
                    <span style={S.subLabel}>Arrow size</span>
                    <input type="range" min={2} max={12} step={1} value={commonArrowSize || 4}
                      onChange={e => applyToSelected({ arrowSize: parseInt(e.target.value) })}
                      style={{ flex: 1, cursor: 'pointer', accentColor: t.textSecondary }} />
                    <span style={{ fontSize: 11, color: t.textTertiary, width: 20, textAlign: 'right' }}>{commonArrowSize || 4}</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div style={S.footer}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.smallBtn} onClick={selectAll}>Select all</button>
            <button style={S.smallBtn} onClick={selectNone}>Select none</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {selectedTracks.length > 0 && <button style={S.btnDanger} onClick={removeSelected}>Remove ({selectedTracks.length})</button>}
          </div>
        </div>
    </DraggablePanel>
  )
}

const ANNOTATION_TYPES = [
  { key: 'cds', label: 'CDS' },
  { key: 'exon', label: 'Exon' },
  { key: 'gene', label: 'Gene' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'utr', label: 'UTR' },
  { key: 'rrna', label: 'rRNA' },
  { key: 'trna', label: 'tRNA' },
  { key: 'repeat', label: 'Repeat' },
  { key: 'default', label: 'Other' },
]

function AnnotationColorSection({ tracks, applyToSelected, theme }) {
  const [expandedType, setExpandedType] = useState(null)
  const nativeRef = useRef(null)
  const [nativeTarget, setNativeTarget] = useState(null) // key being edited via native picker

  // Use first selected track's annotation colors as the baseline
  const overrides = tracks[0]?.annotationColors || {}

  function resolveColor(key) {
    return overrides[key] || DEFAULT_ANNOTATION_COLORS[key] || '#80cbc4'
  }

  function setColor(key, color) {
    for (const t of tracks) {
      const updated = { ...(t.annotationColors || {}), [key]: color }
      applyToSelected({ annotationColors: updated })
    }
  }

  function resetAll() {
    applyToSelected({ annotationColors: null })
  }

  function openNativePicker(key) {
    setNativeTarget(key)
    if (nativeRef.current) {
      nativeRef.current.value = resolveColor(key)
      nativeRef.current.click()
    }
  }

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '0 0 0 0' }}>
        <span style={{ fontSize: 12, color: theme.textSecondary, width: 90 }}>Annotation colors</span>
        <button
          style={{ background: 'none', border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
            color: theme.textTertiary, cursor: 'pointer', fontSize: 10, padding: '1px 6px' }}
          onClick={resetAll}
        >Reset</button>
      </div>
      {ANNOTATION_TYPES.map(({ key, label }) => {
        const current = resolveColor(key)
        return (
          <div key={key}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
                cursor: 'pointer', fontSize: 11, color: theme.textPrimary, borderRadius: 3,
              }}
              onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => setExpandedType(expandedType === key ? null : key)}
            >
              <span
                style={{
                  width: 14, height: 14, borderRadius: 3, background: current,
                  border: '1px solid rgba(255,255,255,0.15)', flexShrink: 0, cursor: 'pointer',
                }}
                onDoubleClick={(e) => { e.stopPropagation(); openNativePicker(key) }}
                title="Click to expand swatches, double-click for full color picker"
              />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{ fontSize: 9, color: theme.textTertiary }}>
                {expandedType === key ? '\u25B2' : '\u25BC'}
              </span>
            </div>
            {expandedType === key && (
              <div style={{ padding: '3px 4px 6px 24px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 6 }}>
                  {ORDERED_COLORS.map(c => (
                    <span
                      key={c}
                      style={{
                        width: 16, height: 16, borderRadius: 3, background: c, cursor: 'pointer',
                        border: c === current ? `2px solid ${theme.textPrimary}` : '1px solid rgba(255,255,255,0.1)',
                        boxSizing: 'border-box',
                      }}
                      onClick={() => { setColor(key, c); setExpandedType(null) }}
                      onDoubleClick={(e) => { e.stopPropagation(); openNativePicker(key) }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: theme.textTertiary }}>Hex:</span>
                  <input
                    type="text"
                    defaultValue={current}
                    placeholder="#ff0000"
                    style={{
                      background: theme.inputBg, border: `1px solid ${theme.borderAccent}`,
                      borderRadius: 3, color: theme.textPrimary, padding: '2px 5px',
                      fontSize: 10, fontFamily: 'monospace', width: 70,
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        let v = e.target.value.trim()
                        if (v && !v.startsWith('#')) v = '#' + v
                        if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
                          setColor(key, v)
                          setExpandedType(null)
                        }
                      }
                    }}
                    onBlur={e => {
                      let v = e.target.value.trim()
                      if (v && !v.startsWith('#')) v = '#' + v
                      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) setColor(key, v)
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                  <span
                    style={{ width: 14, height: 14, borderRadius: 3, background: current, border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', flexShrink: 0 }}
                    onDoubleClick={(e) => { e.stopPropagation(); openNativePicker(key) }}
                    title="Double-click for color picker"
                  />
                </div>
              </div>
            )}
          </div>
        )
      })}
      <input
        ref={nativeRef}
        type="color"
        style={{ position: 'absolute', left: -9999, top: -9999, opacity: 0, width: 0, height: 0 }}
        onChange={(e) => { if (nativeTarget) setColor(nativeTarget, e.target.value) }}
      />
    </div>
  )
}

/** Toggle which annotation feature types are shown (e.g. CDS, gene, tRNA, repeat_region). */
function FeatureTypeSection({ tracks, applyToSelected, theme }) {
  const [expanded, setExpanded] = useState(false)

  // Aggregate available feature types from all selected annotation tracks
  const allTypes = new Set()
  for (const tr of tracks) {
    if (tr.track_type !== 'annotations' && tr.track_type !== 'genome_annotations') continue
    for (const ft of (tr.featureTypes || [])) allTypes.add(ft)
  }
  const featureTypes = Array.from(allTypes).sort()

  if (featureTypes.length === 0) return null

  // A type is shown if NO selected track has it in hiddenFeatureTypes
  // A type is hidden if ALL selected tracks have it hidden
  // Otherwise mixed
  function getState(type) {
    let hiddenCount = 0
    let total = 0
    for (const tr of tracks) {
      if (tr.track_type !== 'annotations' && tr.track_type !== 'genome_annotations') continue
      total++
      if ((tr.hiddenFeatureTypes || []).includes(type)) hiddenCount++
    }
    if (hiddenCount === 0) return 'shown'
    if (hiddenCount === total) return 'hidden'
    return 'mixed'
  }

  function toggleType(type) {
    const state = getState(type)
    const shouldHide = state === 'shown' // if currently shown (or mixed treated as hide-all), hide; else show
    // For "mixed" state we go to "shown" (uncheck) — feels more useful
    const targetHide = state === 'shown'
    for (const tr of tracks) {
      if (tr.track_type !== 'annotations' && tr.track_type !== 'genome_annotations') continue
      const current = new Set(tr.hiddenFeatureTypes || [])
      if (targetHide) current.add(type); else current.delete(type)
      applyToSelected({ hiddenFeatureTypes: Array.from(current) })
    }
  }

  function showAll() {
    applyToSelected({ hiddenFeatureTypes: [] })
  }

  function hideAll() {
    applyToSelected({ hiddenFeatureTypes: [...featureTypes] })
  }

  const hiddenCount = featureTypes.filter(t => getState(t) === 'hidden').length
  const summary = hiddenCount === 0
    ? `All ${featureTypes.length} shown`
    : `${featureTypes.length - hiddenCount}/${featureTypes.length} shown`

  return (
    <div style={{ padding: '4px 0' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
          cursor: 'pointer', userSelect: 'none',
        }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 12, color: theme.textSecondary, width: 90 }}>Feature types</span>
        <span style={{ fontSize: 11, color: theme.textTertiary, flex: 1 }}>{summary}</span>
        <span style={{ fontSize: 9, color: theme.textTertiary }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>
      {expanded && (
        <div style={{ paddingLeft: 16, marginLeft: 4, borderLeft: `2px solid ${theme.border}` }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button
              style={{ background: 'none', border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
                color: theme.textSecondary, cursor: 'pointer', fontSize: 10, padding: '2px 8px' }}
              onClick={showAll}
            >Show all</button>
            <button
              style={{ background: 'none', border: `1px solid ${theme.borderAccent}`, borderRadius: 3,
                color: theme.textSecondary, cursor: 'pointer', fontSize: 10, padding: '2px 8px' }}
              onClick={hideAll}
            >Hide all</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'auto' }}>
            {featureTypes.map(type => {
              const state = getState(type)
              const checked = state === 'shown'
              return (
                <label
                  key={type}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                    color: theme.textPrimary, cursor: 'pointer', padding: '2px 4px', borderRadius: 3,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = theme.selectedRow || 'rgba(255,255,255,0.05)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    ref={el => { if (el) el.indeterminate = state === 'mixed' }}
                    onChange={() => toggleType(type)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontFamily: 'monospace' }}>{type}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact color picker with swatch grid popover, hex input, and OS picker (on double-click).
 *  Used for read-track strand colors so users can quickly pick from common palette
 *  swatches in addition to entering a hex code or opening the full OS color picker. */
function SwatchColorPicker({ value, onChange, theme }) {
  const [open, setOpen] = useState(false)
  const swatchRef = useRef(null)
  const nativeRef = useRef(null)
  const popRef = useRef(null)

  // Close popover when clicking outside
  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (popRef.current && !popRef.current.contains(e.target) &&
          swatchRef.current && !swatchRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const rect = open && swatchRef.current ? swatchRef.current.getBoundingClientRect() : null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, position: 'relative' }}>
      <span
        ref={swatchRef}
        style={{
          width: 20, height: 16, borderRadius: 3, background: value,
          border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', flexShrink: 0,
        }}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        onDoubleClick={(e) => { e.stopPropagation(); setOpen(false); nativeRef.current?.click() }}
        title="Click for swatches, double-click for full picker"
      />
      <input
        type="text"
        defaultValue={value}
        key={value}
        placeholder="#hex"
        style={{
          background: theme.inputBg, border: `1px solid ${theme.borderAccent}`,
          borderRadius: 3, color: theme.textPrimary, padding: '1px 4px',
          fontSize: 10, fontFamily: 'monospace', width: 62,
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            let v = e.target.value.trim()
            if (v && !v.startsWith('#')) v = '#' + v
            if (/^#[0-9a-fA-F]{3,8}$/.test(v)) onChange(v)
          }
        }}
        onBlur={e => {
          let v = e.target.value.trim()
          if (v && !v.startsWith('#')) v = '#' + v
          if (/^#[0-9a-fA-F]{3,8}$/.test(v)) onChange(v)
        }}
        onClick={e => e.stopPropagation()}
      />
      <input ref={nativeRef} type="color" value={value || '#ffffff'}
        onChange={e => onChange(e.target.value)}
        style={{ position: 'absolute', left: -9999, opacity: 0, width: 0, height: 0 }} />
      {open && rect && createPortal(
        <div
          ref={popRef}
          style={{
            position: 'fixed',
            left: Math.min(rect.left, window.innerWidth - 180),
            top: rect.bottom + 4,
            zIndex: 10001,
            background: theme.panelBg,
            border: `1px solid ${theme.borderAccent}`,
            borderRadius: 4,
            padding: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            display: 'grid', gridTemplateColumns: 'repeat(8, 18px)', gap: 3,
          }}
        >
          {ORDERED_COLORS.map(c => (
            <span
              key={c}
              style={{
                width: 18, height: 18, borderRadius: 3, background: c, cursor: 'pointer',
                border: c === value ? `2px solid ${theme.textPrimary}` : '1px solid rgba(255,255,255,0.15)',
                boxSizing: 'border-box',
              }}
              onClick={() => { onChange(c); setOpen(false) }}
              onDoubleClick={(e) => { e.stopPropagation(); setOpen(false); nativeRef.current?.click() }}
              title={c}
            />
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

/** Compact color input: swatch (double-click for OS picker) + hex text input. */
function ColorHexInput({ value, onChange, theme }) {
  const nativeRef = useRef(null)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{ width: 20, height: 16, borderRadius: 3, background: value, border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', flexShrink: 0 }}
        onDoubleClick={() => nativeRef.current?.click()}
        onClick={() => nativeRef.current?.click()}
        title="Click for color picker"
      />
      <input
        type="text"
        defaultValue={value}
        key={value}
        placeholder="#hex"
        style={{
          background: theme.inputBg, border: `1px solid ${theme.borderAccent}`,
          borderRadius: 3, color: theme.textPrimary, padding: '1px 4px',
          fontSize: 10, fontFamily: 'monospace', width: 62,
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            let v = e.target.value.trim()
            if (v && !v.startsWith('#')) v = '#' + v
            if (/^#[0-9a-fA-F]{3,8}$/.test(v)) onChange(v)
          }
        }}
        onBlur={e => {
          let v = e.target.value.trim()
          if (v && !v.startsWith('#')) v = '#' + v
          if (/^#[0-9a-fA-F]{3,8}$/.test(v)) onChange(v)
        }}
        onClick={e => e.stopPropagation()}
      />
      <input ref={nativeRef} type="color" value={value || '#ffffff'}
        onChange={e => onChange(e.target.value)}
        style={{ position: 'absolute', left: -9999, opacity: 0, width: 0, height: 0 }} />
    </div>
  )
}
