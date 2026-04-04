/**
 * useTrackData.js — Data fetching hook for track components.
 *
 * Manages loading/error state and an overscan cache so panning
 * doesn't re-fetch on every pixel. Supports coverage, reads, variants, features.
 *
 * Zoom-aware: when the zoom level changes while the viewport is still
 * within the overscan region, a 1-second debounced refetch is scheduled
 * to get data at the correct resolution for the new zoom level.
 */
import { useState, useEffect, useRef } from 'react'
import { tracksApi } from '../api/client'

const READ_DETAIL_THRESHOLD = 50_000
const OVERSCAN = 1.0        // fetch 1x extra on each side (3x total viewport width)
const REFETCH_DEBOUNCE = 120 // ms — delay refetches during rapid panning
const ZOOM_REFETCH_DELAY = 1000 // ms — delay before refetching at new resolution

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
const liveData = new Map()

function setLiveData(trackId, data) {
  liveData.set(trackId, data)
}

export function getLiveTrackData(trackId) {
  return liveData.get(trackId) || null
}

export function getCachedDataForTrack(trackId, chrom) {
  const live = liveData.get(trackId)
  if (live) return live
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
  const fetchedRef = useRef(null)
  const debounceRef = useRef(null)
  const zoomDebounceRef = useRef(null)
  const hasDataRef = useRef(false)

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

    // Check if viewport fits within already-fetched overscan
    const f = fetchedRef.current
    if (f && f.trackId === track.id && f.chrom === chrom &&
        start >= f.start && end <= f.end) {
      // Viewport is within overscan — keep showing current data.
      // But if zoom level changed, schedule a delayed refetch at
      // the correct resolution (fires after user stops zooming).
      const zoomRatio = viewLen / (f.viewLen || viewLen)
      if (zoomRatio > 0.8 && zoomRatio < 1.2) {
        // Same zoom level, just panning — no refetch needed
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
        return
      }
      // Zoom changed — schedule resolution refetch after 1 second
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
      zoomDebounceRef.current = setTimeout(() => {
        // Force a refetch by clearing the fetched ref
        fetchedRef.current = null
        // Trigger re-render which will enter the fetch path below
        setData(prev => ({ ...prev, _zoomRefetch: Date.now() }))
      }, ZOOM_REFETCH_DELAY)
      return
    }

    // Clear zoom debounce since we're doing a real fetch
    if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)

    // Determine overscan bounds
    const useOverscan = type !== 'reads' || viewLen > READ_DETAIL_THRESHOLD
    const os = useOverscan ? OVERSCAN : 0
    const fetchStart = Math.max(0, Math.floor(start - viewLen * os))
    const fetchEnd = Math.ceil(end + viewLen * os)
    const ratio = (fetchEnd - fetchStart) / viewLen
    const bins = Math.min(Math.floor(canvasWidth * ratio), 5000)

    const cacheKey = `${track.id}|${type}|${chrom}|${fetchStart}|${fetchEnd}|${bins}`

    const cached = cache.get(cacheKey)
    if (cached) {
      setData(cached)
      setLiveData(track.id, cached)
      setError(null)
      fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen }
      hasDataRef.current = true
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)

    const doFetch = () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

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

    if (hasDataRef.current && f?.chrom === chrom) {
      debounceRef.current = setTimeout(doFetch, REFETCH_DEBOUNCE)
    } else {
      doFetch()
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
    }
  }, [track?.id, region?.chrom, region?.start, region?.end, canvasWidth, data?._zoomRefetch])

  return { data, loading, error }
}
