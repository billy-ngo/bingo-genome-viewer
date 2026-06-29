/**
 * TrackContext.jsx — Track list state management.
 *
 * Provides: tracks, addTrack, removeTrack, updateTrack, reorderTracks, setTracks.
 * Handles file upload to backend and local display settings per track.
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { tracksApi } from '../api/client'
import { clearTrackData } from '../hooks/useTrackData'

const TrackContext = createContext(null)

const TRACK_COLORS = [
  '#78909c', '#81c784', '#ffb74d', '#f06292',
  '#ce93d8', '#80cbc4', '#fff176', '#ff8a65',
]

export const DEFAULT_ANNOTATION_COLORS = {
  cds: '#66bb6a', exon: '#42a5f5', gene: '#7e57c2',
  transcript: '#ab47bc', utr: '#26c6da',
  rrna: '#ffa726', trna: '#ef5350',
  repeat: '#8d6e63', default: '#80cbc4',
}

/** Generate a unique overlay-group id. */
function makeGroupId() {
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `ovl-${rand}`
}

/** Decode literal \\uXXXX escape sequences that can appear in filenames */
export function cleanName(s) {
  if (!s) return s
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export function TrackProvider({ children }) {
  const [tracks, setTracks] = useState([])
  const [error, setError] = useState(null)
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  /** Upload a track file to the backend without adding to UI state.
   *  For BAM files, pass the matching .bai as indexFile.
   *  onProgress receives { loaded, total, percent }.
   *  Returns the track info including a `compatibility` field. */
  const uploadTrack = useCallback(async (file, name, indexFile, onProgress) => {
    try {
      const res = await tracksApi.load(file, name, indexFile, onProgress)
      const info = res.data
      if (info.name) info.name = cleanName(info.name)
      setError(null)
      return info
    } catch (e) {
      const msg = e.response?.data?.detail || e.message || String(e)
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg))
      throw e
    }
  }, [])

  /** Add a previously uploaded track to the UI state. */
  const commitTrack = useCallback((info) => {
    setTracks(prev => {
      const color = TRACK_COLORS[prev.length % TRACK_COLORS.length]
      const isAnnotation = info.track_type === 'annotations' || info.track_type === 'genome_annotations'
      return [...prev, {
        ...info, color,
        height: defaultTrackHeight(info.track_type),
        autoHeight: true,   // auto-fit height to show all rows (see TrackPanel)
        visible: true,
        useArrows: true,
        scaleMax: null,
        scaleMin: null,
        autoScaleVisible: false,  // auto-fit Y scale to the visible region (pan-responsive)
        linkScale: false,         // share the auto Y scale across linked coverage/read tracks
        logScale: false,
        barAutoWidth: true,
        barWidth: 2,
        showOutline: false,
        outlineColor: null,
        outlineSmooth: 0,
        showBars: true,
        showNucleotides: true,
        fwdColor: null,     // forward strand color (null = default #90a4ae)
        revColor: null,     // reverse strand color (null = default #f06292)
        arrowStyle: 'pointed', // 'pointed', 'flat', 'chevron', 'fade'
        arrowSize: 4,       // arrow tip size in pixels (2-12)
        showFwdStrand: true, // show forward-strand reads (BAM)
        showRevStrand: true, // show reverse-strand reads (BAM)
        regionOverlays: [], // [{ chrom, start, end, color, opacity }]
        overlayGroup: null,   // id of the overlay group this coverage track belongs to (null = standalone)
        overlayOpacity: 0.6,  // per-track alpha when drawn in an overlay group (0..1)
        targetChromosomes: info.target_chromosomes || null,
        ...(isAnnotation ? {
          annotationColors: null,
          featureTypes: info.feature_types || [],
          hiddenFeatureTypes: [],
        } : {}),
      }]
    })
  }, [])

  /** Discard a track that was uploaded to the backend but not committed. */
  const discardTrack = useCallback(async (id) => {
    try { await tracksApi.remove(id) } catch (e) { /* ignore */ }
  }, [])

  /** Convenience: upload + commit in one call (used by session restore etc.). */
  const addTrack = useCallback(async (file, name) => {
    const info = await uploadTrack(file, name)
    commitTrack(info)
    return info
  }, [uploadTrack, commitTrack])

  const removeTrack = useCallback(async (id) => {
    const track = tracksRef.current.find(t => t.id === id)
    // Genome annotation tracks are hidden (not deleted) so they can be
    // restored when the user navigates back to an annotated chromosome.
    // Mark `userRemoved` so a *deliberate* removal is NOT auto-revived on
    // the next chromosome change (see restoreAnnotationTracks). Without
    // this flag the removed annotation track reappeared on navigation and
    // ghosted back into the export.
    if (track && track.track_type === 'genome_annotations') {
      setTracks(prev => prev.map(t => t.id === id ? { ...t, visible: false, userRemoved: true } : t))
      return
    }
    // Optimistically drop the track from UI state — the backend DELETE is
    // best-effort cleanup, not a precondition for the row disappearing.
    // Previously the filter ran only AFTER `await tracksApi.remove(id)`
    // resolved, so any failed DELETE (404 for a stale id after a server
    // restart, a 5xx, or a network drop) left the track in tracks[] with
    // visible:true — a phantom row that then ghosted into the SVG/PNG
    // export and enlarged it by its full height.
    setTracks(prev => {
      const removed = prev.find(t => t.id === id)
      let next = prev.filter(t => t.id !== id)
      // If the removed track was in an overlay group now left with <2 members,
      // dissolve the remnant so it renders as a normal (opaque) standalone track
      // rather than a stranded one-track "overlay".
      if (removed?.overlayGroup) {
        const gid = removed.overlayGroup
        if (next.filter(t => t.overlayGroup === gid).length < 2) {
          next = next.map(t => t.overlayGroup === gid ? { ...t, overlayGroup: null } : t)
        }
      }
      return next
    })
    clearTrackData(id)
    try {
      await tracksApi.remove(id)
    } catch (e) {
      // 404 = already gone server-side (expected after a restart). Any
      // other error is non-fatal now that the UI is already consistent;
      // surface it but never re-add the track.
      if (e.response?.status !== 404) {
        setError(e.response?.data?.detail || e.message)
      }
    }
  }, [])

  const restoreAnnotationTracks = useCallback(() => {
    setTracks(prev => prev.map(t =>
      t.track_type === 'genome_annotations' && !t.visible && !t.userRemoved
        ? { ...t, visible: true }
        : t
    ))
  }, [])

  const updateTrack = useCallback((id, updates) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t))
  }, [])

  const updateMultipleTracks = useCallback((ids, updates) => {
    setTracks(prev => prev.map(t => ids.includes(t.id) ? { ...t, ...updates } : t))
  }, [])

  // Group-aware reorder. When the dragged track belongs to an overlay group,
  // the WHOLE contiguous group block moves together so the group stays intact
  // (overlay members are always kept contiguous in the array). Otherwise this
  // behaves like a single-element move.
  const reorderTracks = useCallback((fromId, toId) => {
    setTracks(prev => {
      const fromT = prev.find(t => t.id === fromId)
      const toT = prev.find(t => t.id === toId)
      if (!fromT || !toT) return prev
      const blockIds = fromT.overlayGroup
        ? prev.filter(t => t.overlayGroup === fromT.overlayGroup).map(t => t.id)
        : [fromId]
      const blockSet = new Set(blockIds)
      if (blockSet.has(toId)) return prev   // dropping onto itself / its own group
      const block = prev.filter(t => blockSet.has(t.id))
      const rest = prev.filter(t => !blockSet.has(t.id))
      // Snap the drop to the target's GROUP boundary: if the target is part of an
      // overlay group, insert before the group's first member (never mid-group,
      // which would split it). Otherwise insert before the target track.
      const insertAt = toT.overlayGroup
        ? rest.findIndex(t => t.overlayGroup === toT.overlayGroup)
        : rest.findIndex(t => t.id === toId)
      if (insertAt === -1) return prev
      return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]
    })
  }, [])

  // ── Overlay groups ────────────────────────────────────────────────
  // Coverage tracks can be merged into an "overlay group": one shared row in
  // which each member is drawn on its own transparent layer (per-member
  // opacity = transparency, array order = stacking hierarchy). Members are
  // kept contiguous in the track array so the group renders and reorders as a
  // single block.

  /** Merge the given (coverage) track ids into a new overlay group. Members
   *  are moved into one contiguous block at the position of the topmost one. */
  const createOverlayGroup = useCallback((ids) => {
    setTracks(prev => {
      const idSet = new Set(ids)
      const memberIds = prev
        .filter(t => idSet.has(t.id) && t.track_type === 'coverage')
        .map(t => t.id)
      if (memberIds.length < 2) return prev
      const groupId = makeGroupId()
      const memberSet = new Set(memberIds)
      // Old groups some members are leaving — dissolve any left too small.
      const oldGroups = new Set(prev.filter(t => memberSet.has(t.id) && t.overlayGroup).map(t => t.overlayGroup))
      let stamped = prev.map(t => memberSet.has(t.id)
        ? { ...t, overlayGroup: groupId, overlayOpacity: t.overlayOpacity ?? 0.6 }
        : t)
      for (const g of oldGroups) {
        if (stamped.filter(t => t.overlayGroup === g).length < 2) {
          stamped = stamped.map(t => t.overlayGroup === g ? { ...t, overlayGroup: null } : t)
        }
      }
      // Pull members out and re-insert them as a contiguous block where the
      // first member currently sits (preserving the members' relative order).
      const firstIdx = stamped.findIndex(t => memberSet.has(t.id))
      const before = stamped.slice(0, firstIdx).filter(t => !memberSet.has(t.id)).length
      const members = stamped.filter(t => memberSet.has(t.id))
      const rest = stamped.filter(t => !memberSet.has(t.id))
      return [...rest.slice(0, before), ...members, ...rest.slice(before)]
    })
  }, [])

  /** Add coverage track(s) to an existing overlay group, placing them at the
   *  end of the group's contiguous block. */
  const addToOverlayGroup = useCallback((groupId, ids) => {
    setTracks(prev => {
      if (!prev.some(t => t.overlayGroup === groupId)) return prev
      const idSet = new Set(ids)
      const newIds = prev
        .filter(t => idSet.has(t.id) && t.track_type === 'coverage' && t.overlayGroup !== groupId)
        .map(t => t.id)
      if (!newIds.length) return prev
      const newSet = new Set(newIds)
      const stamped = prev.map(t => newSet.has(t.id)
        ? { ...t, overlayGroup: groupId, overlayOpacity: t.overlayOpacity ?? 0.6 }
        : t)
      // Rebuild so the whole group is contiguous: existing members first (in
      // their order), then the newly added ones, anchored at the group start.
      const inGroup = t => t.overlayGroup === groupId
      const firstIdx = stamped.findIndex(inGroup)
      const before = stamped.slice(0, firstIdx).filter(t => !inGroup(t)).length
      const groupMembers = stamped.filter(inGroup)
      const rest = stamped.filter(t => !inGroup(t))
      return [...rest.slice(0, before), ...groupMembers, ...rest.slice(before)]
    })
  }, [])

  /** Dissolve an overlay group entirely — every member becomes standalone. */
  const dissolveOverlayGroup = useCallback((groupId) => {
    setTracks(prev => prev.map(t => t.overlayGroup === groupId ? { ...t, overlayGroup: null } : t))
  }, [])

  /** Remove one track from its overlay group. If that leaves a single member,
   *  the group is dissolved (a one-track overlay is just a normal track). */
  const removeFromOverlayGroup = useCallback((trackId) => {
    setTracks(prev => {
      const t = prev.find(x => x.id === trackId)
      if (!t || !t.overlayGroup) return prev
      const gid = t.overlayGroup
      const survivors = prev.filter(x => x.overlayGroup === gid && x.id !== trackId)
      // Fewer than 2 left → dissolve the whole group (positions unchanged).
      if (survivors.length < 2) {
        return prev.map(x => x.overlayGroup === gid ? { ...x, overlayGroup: null } : x)
      }
      // Group survives: pull the removed track OUT of the group's span and drop
      // it right after the group's last member so the survivors stay contiguous.
      const removed = { ...t, overlayGroup: null }
      const without = prev.filter(x => x.id !== trackId)
      let lastIdx = -1
      without.forEach((x, i) => { if (x.overlayGroup === gid) lastIdx = i })
      return [...without.slice(0, lastIdx + 1), removed, ...without.slice(lastIdx + 1)]
    })
  }, [])

  /** Move a member up (dir -1) or down (dir +1) within its overlay group,
   *  changing the draw order / stacking hierarchy. */
  const reorderOverlayMember = useCallback((trackId, dir) => {
    setTracks(prev => {
      const t = prev.find(x => x.id === trackId)
      if (!t || !t.overlayGroup) return prev
      const gid = t.overlayGroup
      const groupIdxs = prev.reduce((acc, x, i) => { if (x.overlayGroup === gid) acc.push(i); return acc }, [])
      const selfIdx = prev.findIndex(x => x.id === trackId)
      const pos = groupIdxs.indexOf(selfIdx)
      const swapPos = pos + dir
      if (swapPos < 0 || swapPos >= groupIdxs.length) return prev
      const a = groupIdxs[pos], b = groupIdxs[swapPos]
      const next = [...prev]
      ;[next[a], next[b]] = [next[b], next[a]]
      return next
    })
  }, [])

  const addGenomeAnnotationTrack = useCallback((info) => {
    setTracks(prev => {
      const idx = prev.findIndex(t => t.id === info.id)
      if (idx !== -1) {
        // Already exists (maybe hidden) — update name, target chromosomes, feature types, and re-show
        const updated = [...prev]
        const merged = {
          ...updated[idx],
          name: cleanName(info.name) || info.name,
          visible: true,
          userRemoved: false,  // re-loading the genome un-does a prior removal
          ...(info.targetChromosomes ? { targetChromosomes: info.targetChromosomes } : {}),
        }
        // Merge new feature types with existing (when adding chromosomes from another file)
        if (info.featureTypes && info.featureTypes.length) {
          const existing = updated[idx].featureTypes || []
          merged.featureTypes = Array.from(new Set([...existing, ...info.featureTypes])).sort()
        }
        updated[idx] = merged
        return updated
      }
      return [...prev, {
        ...info,
        name: cleanName(info.name) || info.name,
        color: '#a5d6a7', height: 80, autoHeight: true, visible: true, useArrows: true,
        userRemoved: false,
        annotationColors: null,
        targetChromosomes: info.targetChromosomes || null,
        featureTypes: info.featureTypes || [],
        hiddenFeatureTypes: [],
      }]
    })
  }, [])

  return (
    <TrackContext.Provider value={{
      tracks, setTracks, addTrack, uploadTrack, commitTrack, discardTrack,
      removeTrack, updateTrack, updateMultipleTracks, reorderTracks,
      createOverlayGroup, addToOverlayGroup, dissolveOverlayGroup,
      removeFromOverlayGroup, reorderOverlayMember,
      addGenomeAnnotationTrack, restoreAnnotationTracks, error, setError,
    }}>
      {children}
    </TrackContext.Provider>
  )
}

export function useTracks() {
  return useContext(TrackContext)
}

export function defaultTrackHeight(trackType) {
  switch (trackType) {
    case 'reads': return 120
    case 'coverage': return 120
    case 'variants': return 60
    case 'annotations':
    case 'genome_annotations': return 80
    default: return 80
  }
}
