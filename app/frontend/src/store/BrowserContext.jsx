/**
 * BrowserContext.jsx — Global navigation state (genome, region, zoom/pan, selection).
 *
 * Provides: genome, genomeLoadId, region, selection, setGenome, navigateTo, zoom, pan,
 * setSelection, getSelection, clearSelection.
 * Uses a ref for immediate region reads to prevent stale-closure panning bugs.
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react'

const BrowserContext = createContext(null)

export function BrowserProvider({ children }) {
  const [genome, setGenomeState] = useState(null)     // { name, chromosomes, is_annotated }
  // Bumped by every setGenome (genome load, added chromosomes, session
  // restore). Two genomes can share contig names, so caches of genome-derived
  // data (the reference bases) key on this rather than on coordinates alone.
  const [genomeLoadId, setGenomeLoadId] = useState(0)
  const [region, setRegion] = useState(null)           // { chrom, start, end }
  const [selection, setSelectionState] = useState(null) // { chrom, start, end } or null
  const genomeRef = useRef(null)
  const regionRef = useRef(null)
  const selectionRef = useRef(null)

  const setGenome = useCallback((g) => {
    genomeRef.current = g
    setGenomeState(g)
    setGenomeLoadId(n => n + 1)
  }, [])

  const navigateTo = useCallback((chrom, start, end) => {
    const g = genomeRef.current
    if (!g) return
    const chr = g.chromosomes.find(c => c.name === chrom)
    if (!chr) return
    // Round the start and keep the requested LENGTH exactly. Flooring the
    // start and ceiling the end grew the view by 1 bp on every pan with a
    // fractional offset (i.e. every mouse drag), so repeated panning slowly
    // zoomed out — and at nucleotide zoom pushed the view past the letter
    // threshold, making the sequence strip vanish until the next zoom.
    const len = Math.max(1, Math.round(end - start))
    let s = Math.round(start)
    let e = s + len
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
    const sel = selectionRef.current
    const len = r.end - r.start
    // If a selection on this chromosome is on screen, zoom centred on it;
    // an off-screen selection must not make the view jump away.
    let anchor = r.start + len * anchorFraction
    if (sel && sel.chrom === r.chrom) {
      const mid = (sel.start + sel.end) / 2
      if (mid >= r.start && mid <= r.end) {
        anchor = mid
        anchorFraction = (anchor - r.start) / len
      }
    }
    const newLen = Math.max(100, len * factor)
    navigateTo(r.chrom, anchor - newLen * anchorFraction, anchor + newLen * (1 - anchorFraction))
  }, [navigateTo])

  const pan = useCallback((bpDelta) => {
    const r = regionRef.current
    if (!r) return
    navigateTo(r.chrom, r.start + bpDelta, r.end + bpDelta)
  }, [navigateTo])

  const setSelection = useCallback((sel) => {
    selectionRef.current = sel
    setSelectionState(sel)
  }, [])

  // The newest selection, before React has rendered it — lets event handlers
  // tell whether the selection they were set up for is still the current one.
  const getSelection = useCallback(() => selectionRef.current, [])

  const clearSelection = useCallback(() => {
    selectionRef.current = null
    setSelectionState(null)
  }, [])

  return (
    <BrowserContext.Provider value={{
      genome, genomeLoadId, setGenome, region, navigateTo, zoom, pan,
      selection, setSelection, getSelection, clearSelection,
    }}>
      {children}
    </BrowserContext.Provider>
  )
}

export function useBrowser() {
  return useContext(BrowserContext)
}
