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
    setTracks(prev => prev.filter(t => t.id !== id))
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

  const reorderTracks = useCallback((fromId, toId) => {
    setTracks(prev => {
      const next = [...prev]
      const fromIdx = next.findIndex(t => t.id === fromId)
      const toIdx = next.findIndex(t => t.id === toId)
      if (fromIdx === -1 || toIdx === -1) return prev
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
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
