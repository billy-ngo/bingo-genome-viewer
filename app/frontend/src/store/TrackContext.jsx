/**
 * TrackContext.jsx — Track list state management.
 *
 * Provides: tracks, addTrack, removeTrack, updateTrack, reorderTracks, setTracks.
 * Handles file upload to backend and local display settings per track.
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { tracksApi } from '../api/client'

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
        height: defaultHeight(info.track_type),
        visible: true,
        useArrows: true,
        scaleMax: null,
        scaleMin: null,
        logScale: false,
        barAutoWidth: true,
        barWidth: 2,
        showOutline: false,
        targetChromosomes: info.target_chromosomes || null,
        ...(isAnnotation ? { annotationColors: null } : {}),
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
    // Genome annotation tracks are hidden (not deleted) so they can be
    // restored when the user navigates back to an annotated chromosome.
    const track = tracksRef.current.find(t => t.id === id)
    if (track && track.track_type === 'genome_annotations') {
      setTracks(prev => prev.map(t => t.id === id ? { ...t, visible: false } : t))
      return
    }
    try {
      await tracksApi.remove(id)
      setTracks(prev => prev.filter(t => t.id !== id))
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }, [])

  const restoreAnnotationTracks = useCallback(() => {
    setTracks(prev => prev.map(t =>
      t.track_type === 'genome_annotations' && !t.visible
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
        // Already exists (maybe hidden) — update name, target chromosomes, and re-show
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          name: cleanName(info.name) || info.name,
          visible: true,
          ...(info.targetChromosomes ? { targetChromosomes: info.targetChromosomes } : {}),
        }
        return updated
      }
      return [...prev, {
        ...info,
        name: cleanName(info.name) || info.name,
        color: '#a5d6a7', height: 80, visible: true, useArrows: true,
        annotationColors: null,
        targetChromosomes: info.targetChromosomes || null,
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

function defaultHeight(trackType) {
  switch (trackType) {
    case 'reads': return 120
    case 'coverage': return 120
    case 'variants': return 60
    case 'annotations':
    case 'genome_annotations': return 80
    default: return 80
  }
}
