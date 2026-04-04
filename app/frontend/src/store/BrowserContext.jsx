/**
 * BrowserContext.jsx — Global navigation state (genome, region, zoom/pan).
 *
 * Provides: genome, region, setGenome, navigateTo, zoom, pan.
 * Uses a ref for immediate region reads to prevent stale-closure panning bugs.
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react'

const BrowserContext = createContext(null)

export function BrowserProvider({ children }) {
  const [genome, setGenomeState] = useState(null)     // { name, chromosomes, is_annotated }
  const [region, setRegion] = useState(null)           // { chrom, start, end }
  const genomeRef = useRef(null)
  const regionRef = useRef(null)

  const setGenome = useCallback((g) => {
    genomeRef.current = g
    setGenomeState(g)
  }, [])

  const navigateTo = useCallback((chrom, start, end) => {
    const g = genomeRef.current
    if (!g) return
    const chr = g.chromosomes.find(c => c.name === chrom)
    if (!chr) return
    let s = Math.floor(start)
    let e = Math.ceil(end)
    const len = e - s
    // Preserve region width: shift the window instead of clamping each edge independently
    if (len <= chr.length) {
      if (s < 0) { s = 0; e = len }
      if (e > chr.length) { e = chr.length; s = e - len }
    } else {
      s = 0; e = chr.length
    }
    s = Math.max(0, s)
    if (e > s) {
      const newRegion = { chrom, start: s, end: e }
      regionRef.current = newRegion
      setRegion(newRegion)
    }
  }, [])

  const zoom = useCallback((factor, anchorFraction = 0.5) => {
    const r = regionRef.current
    if (!r) return
    const len = r.end - r.start
    const anchor = r.start + len * anchorFraction
    const newLen = Math.max(100, len * factor)
    navigateTo(r.chrom, anchor - newLen * anchorFraction, anchor + newLen * (1 - anchorFraction))
  }, [navigateTo])

  const pan = useCallback((bpDelta) => {
    const r = regionRef.current
    if (!r) return
    navigateTo(r.chrom, r.start + bpDelta, r.end + bpDelta)
  }, [navigateTo])

  return (
    <BrowserContext.Provider value={{ genome, setGenome, region, navigateTo, zoom, pan }}>
      {children}
    </BrowserContext.Provider>
  )
}

export function useBrowser() {
  return useContext(BrowserContext)
}
