/**
 * PeakContext.jsx — Shares ranked peak features so their rank labels can be
 * overlaid on coverage/read tracks.
 *
 * A peak annotation track (one whose features carry a `rank`) publishes its
 * currently-loaded, in-region features here whenever its data changes. The
 * PeakRankOverlay rendered over each coverage/read track consumes them and
 * draws rank labels at the matching x-positions. Using React state (rather
 * than reading the module-level live-data cache) makes the overlays update
 * reactively as peaks load and the viewport pans/zooms.
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'

const PeakContext = createContext(null)

export function PeakProvider({ children }) {
  const [peaksByTrack, setPeaksByTrack] = useState({})  // { trackId: [feature, ...] }

  const publishPeaks = useCallback((trackId, features) => {
    setPeaksByTrack(prev => {
      const next = prev[trackId]
      // Avoid a state update (and re-render storm) when nothing changed.
      if (next && next === features) return prev
      return { ...prev, [trackId]: features }
    })
  }, [])

  const clearPeaks = useCallback((trackId) => {
    setPeaksByTrack(prev => {
      if (!(trackId in prev)) return prev
      const n = { ...prev }
      delete n[trackId]
      return n
    })
  }, [])

  const value = useMemo(() => ({ peaksByTrack, publishPeaks, clearPeaks }), [peaksByTrack, publishPeaks, clearPeaks])
  return <PeakContext.Provider value={value}>{children}</PeakContext.Provider>
}

export function usePeaks() {
  return useContext(PeakContext) || { peaksByTrack: {}, publishPeaks: () => {}, clearPeaks: () => {} }
}
