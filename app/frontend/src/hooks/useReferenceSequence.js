/**
 * useReferenceSequence.js — Reference bases for the view, shared by the
 * annotation track's sequence strip and the read track's mismatch display.
 *
 * Replaces two copies of an effect that dropped out while scrolling:
 *  - the sequence was discarded whenever the view momentarily fell below the
 *    letter-drawing threshold, and a de-dupe key that was never cleared then
 *    blocked the refetch, so the strip stayed blank until the next zoom;
 *  - responses could arrive out of order, so an older window overwrote the
 *    one for the current view.
 * Here the sequence is fetched whenever the view is short enough to plausibly
 * show bases (drawing decides separately whether letters fit), the newest
 * request always wins, a request already in flight is reused for every view
 * it covers (a drag past the edge of the fetched bases used to send one
 * request per mouse move), identical requests from several tracks are shared,
 * transient failures are retried, and recent windows are cached so panning
 * back and forth never refetches.
 */
import { useState, useEffect } from 'react'
import { genomeApi } from '../api/client'

const SEQ_FETCH_MAX = 2000      // fetch bases for views up to this many bp
const MIN_MARGIN = 500          // extra bases each side (at least), so pans stay covered
const MAX_WINDOWS = 24
const RETRY_DELAYS = [250, 750]

const windows = new Map()       // `${chrom}:${start}-${end}` -> { chrom, start, end, sequence }
const inflight = new Map()      // same key -> { chrom, start, end, promise }

function remember(w) {
  if (windows.size >= MAX_WINDOWS) windows.delete(windows.keys().next().value)
  windows.set(`${w.chrom}:${w.start}-${w.end}`, w)
}

function covering(map, chrom, start, end) {
  for (const w of map.values()) {
    if (w.chrom === chrom && w.start <= start && w.end >= end) return w
  }
  return null
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function fetchWindow(chrom, start, end) {
  const key = `${chrom}:${start}-${end}`
  if (inflight.has(key)) return inflight.get(key).promise
  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await genomeApi.sequence(chrom, start, end)
        const sequence = res.data.sequence || ''
        // The backend truncates at the chromosome end; record what we really have.
        const w = { chrom, start, end: start + sequence.length, sequence }
        remember(w)
        return w
      } catch (e) {
        const status = e.response?.status
        if (attempt >= RETRY_DELAYS.length || (status && status < 500)) throw e
        await sleep(RETRY_DELAYS[attempt])
      }
    }
  })().finally(() => inflight.delete(key))
  inflight.set(key, { chrom, start, end, promise })
  return promise
}

/** The reference window covering (or, while a fetch is pending, best
 *  overlapping) the view, or null when sequence display is off / the view is
 *  too wide. Bases outside the window's [start, end) are simply not drawn. */
export function useReferenceSequence(region, enabled) {
  const [seq, setSeq] = useState(null)
  useEffect(() => {
    if (!enabled || !region || region.end - region.start > SEQ_FETCH_MAX) {
      setSeq(null)
      return undefined
    }
    const hit = covering(windows, region.chrom, region.start, region.end)
    if (hit) {
      setSeq(hit)
      return undefined
    }
    let cancelled = false
    const pending = covering(inflight, region.chrom, region.start, region.end)
    let promise
    if (pending) {
      promise = pending.promise
    } else {
      const margin = Math.max(MIN_MARGIN, Math.round(region.end - region.start))
      promise = fetchWindow(region.chrom, Math.max(0, Math.floor(region.start) - margin), Math.ceil(region.end) + margin)
    }
    promise
      .then(w => { if (!cancelled) setSeq(w) })
      .catch(() => { /* keep the previous window; the next view change retries */ })
    return () => { cancelled = true }
  }, [region?.chrom, region?.start, region?.end, enabled])
  return seq && region && seq.chrom === region.chrom ? seq : null
}
