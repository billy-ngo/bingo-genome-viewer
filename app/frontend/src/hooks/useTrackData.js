/**
 * useTrackData.js — Data fetching hook for track components.
 *
 * Manages loading/error state and an overscan cache so panning
 * doesn't re-fetch on every pixel. Supports coverage, reads, variants, features.
 */
import { useState, useEffect, useRef } from 'react'
import { tracksApi } from '../api/client'

const READ_DETAIL_THRESHOLD = 50_000
const OVERSCAN = 1.0        // fetch 1x extra on each side (3x total viewport width)
const REFETCH_DEBOUNCE = 120 // ms — delay refetches during rapid panning

// Simple LRU cache keyed by string
function makeCache(maxSize = 200) {
  const map = new Map()
  return {
    get(key) { return map.get(key) },
    set(key, val) {
      if (map.size >= maxSize) {
        map.delete(map.keys().next().value)
      }
      map.set(key, val)
    },
    findByPrefix(prefix) {
      // Return the LAST (most recent) match, not the first
      let result = null
      for (const [key, val] of map) {
        if (key.startsWith(prefix)) result = val
      }
      return result
    },
  }
}
const cache = makeCache()

// ─── Live data store ────────────────────────────────────────────────────────
// Stores the *currently rendered* data for each track — written every time
// a track component receives new data, so the export always reads exactly
// what is on screen.
const liveData = new Map()

/** Called internally whenever a track component gets data */
function setLiveData(trackId, data) {
  liveData.set(trackId, data)
}

/** Retrieve the data currently rendered by a track component (for export) */
export function getLiveTrackData(trackId) {
  return liveData.get(trackId) || null
}

/** Legacy helper used by annotation tooltip to sum bins across tracks */
export function getCachedDataForTrack(trackId, chrom) {
  // Try live data first (always up-to-date)
  const live = liveData.get(trackId)
  if (live) return live
  // Fall back to cache prefix search
  return cache.findByPrefix(`${trackId}|coverage|${chrom}|`)
    || cache.findByPrefix(`${trackId}|reads|${chrom}|`)
    || cache.findByPrefix(`${trackId}|annotations|${chrom}|`)
    || cache.findByPrefix(`${trackId}|genome_annotations|${chrom}|`)
    || cache.findByPrefix(`${trackId}|variants|${chrom}|`)
    || null
}

export function useTrackData(track, region, canvasWidth) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)
  const fetchedRef = useRef(null)   // { trackId, chrom, start, end } — bounds of last successful fetch
  const debounceRef = useRef(null)
  const hasDataRef = useRef(false)  // whether we've ever received data for current track

  useEffect(() => {
    if (!track || !region || !canvasWidth) return
    const { chrom, start, end } = region
    const viewLen = end - start
    const type = track.track_type

    // Reset when track changes
    if (fetchedRef.current && fetchedRef.current.trackId !== track.id) {
      fetchedRef.current = null
      hasDataRef.current = false
    }

    // Check if current viewport fits within the already-fetched overscan region
    // AND the zoom level hasn't changed significantly (within 20%)
    const f = fetchedRef.current
    if (f && f.trackId === track.id && f.chrom === chrom &&
        start >= f.start && end <= f.end) {
      // If zoom level changed by >20%, refetch at new resolution
      const zoomRatio = viewLen / (f.viewLen || viewLen)
      if (zoomRatio > 0.8 && zoomRatio < 1.2) {
        return
      }
    }

    // Determine overscan bounds for the fetch
    // (skip overscan for individual-read mode since it's expensive)
    const useOverscan = type !== 'reads' || viewLen > READ_DETAIL_THRESHOLD
    const os = useOverscan ? OVERSCAN : 0
    const fetchStart = Math.max(0, Math.floor(start - viewLen * os))
    const fetchEnd = Math.ceil(end + viewLen * os)
    const ratio = (fetchEnd - fetchStart) / viewLen
    const bins = Math.min(Math.floor(canvasWidth * ratio), 5000)

    const cacheKey = `${track.id}|${type}|${chrom}|${fetchStart}|${fetchEnd}|${bins}`

    // Check in-memory cache
    const cached = cache.get(cacheKey)
    if (cached) {
      setData(cached)
      setLiveData(track.id, cached)
      setError(null)
      fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen }
      hasDataRef.current = true
      return
    }

    // Clear any pending debounced fetch
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const doFetch = () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

      // Only show loading spinner if we have no data at all (first load).
      // During panning refetches, keep rendering stale data instead of blanking.
      if (!hasDataRef.current) setLoading(true)
      setError(null)

      let promise
      if (type === 'reads') {
        if (viewLen <= READ_DETAIL_THRESHOLD) {
          promise = tracksApi.reads(track.id, chrom, start, end)
        } else {
          promise = tracksApi.coverage(track.id, chrom, fetchStart, fetchEnd, bins)
        }
      } else if (type === 'coverage') {
        promise = tracksApi.coverage(track.id, chrom, fetchStart, fetchEnd, bins)
      } else if (type === 'variants') {
        promise = tracksApi.variants(track.id, chrom, fetchStart, fetchEnd)
      } else if (type === 'annotations' || type === 'genome_annotations') {
        promise = tracksApi.features(track.id, chrom, fetchStart, fetchEnd)
      } else {
        setLoading(false)
        return
      }

      promise
        .then(res => {
          if (controller.signal.aborted) return
          const result = {
            ...res.data,
            mode: type === 'reads' && viewLen <= READ_DETAIL_THRESHOLD ? 'reads' : 'coverage',
          }
          cache.set(cacheKey, result)
          fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen }
          hasDataRef.current = true
          setData(result)
          setLiveData(track.id, result)
          setError(null)
        })
        .catch(err => {
          if (err.name !== 'CanceledError' && !controller.signal.aborted) {
            const detail = err.response?.data?.detail
            const msg = typeof detail === 'string' ? detail : err.message || String(err)
            setError(msg)
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }

    // Debounce refetches when we already have data (user is actively panning).
    // Fetch immediately if this is a new chromosome or we have no data yet.
    if (hasDataRef.current && f?.chrom === chrom) {
      debounceRef.current = setTimeout(doFetch, REFETCH_DEBOUNCE)
    } else {
      doFetch()
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [track?.id, region?.chrom, region?.start, region?.end, canvasWidth])

  return { data, loading, error }
}
