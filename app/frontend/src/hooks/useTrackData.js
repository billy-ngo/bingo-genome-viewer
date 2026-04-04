/**
 * useTrackData.js — Data fetching hook for track components.
 *
 * Manages loading/error state and an overscan cache so panning
 * doesn't re-fetch on every pixel. Supports coverage, reads, variants, features.
 *
 * Three fetch strategies:
 * 1. Viewport within overscan, same zoom: skip fetch (cached data is fine)
 * 2. Viewport within overscan, different zoom: debounced 1s refetch at new resolution
 * 3. Viewport outside overscan: immediate fetch (pan debounce 120ms, or instant if
 *    no data exists yet)
 *
 * Old data is NEVER cleared — it stays on screen during fetches so there are
 * no blank chunks while the new data loads.
 */
import { useState, useEffect, useRef } from 'react'
import { tracksApi } from '../api/client'

const READ_DETAIL_THRESHOLD = 50_000
const OVERSCAN = 1.0
const PAN_DEBOUNCE = 120
const ZOOM_REFETCH_DELAY = 1000

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

const liveData = new Map()

function setLiveData(trackId, data) { liveData.set(trackId, data) }

export function getLiveTrackData(trackId) { return liveData.get(trackId) || null }

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
  const fetchedRef = useRef(null)   // { trackId, chrom, start, end, viewLen }
  const debounceRef = useRef(null)
  const zoomDebounceRef = useRef(null)
  const hasDataRef = useRef(false)

  useEffect(() => {
    if (!track || !region || !canvasWidth) return
    const { chrom, start, end } = region
    const viewLen = end - start
    const type = track.track_type

    if (fetchedRef.current && fetchedRef.current.trackId !== track.id) {
      fetchedRef.current = null
      hasDataRef.current = false
    }

    const f = fetchedRef.current
    const withinOverscan = f && f.trackId === track.id && f.chrom === chrom &&
      start >= f.start && end <= f.end

    if (withinOverscan) {
      const zoomRatio = viewLen / (f.viewLen || viewLen)
      if (zoomRatio > 0.8 && zoomRatio < 1.2) {
        // Same zoom, within overscan — nothing to do
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
        return
      }
      // Zoom changed but still within overscan — schedule resolution refetch.
      // Keep showing current data (no clearing).
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
      zoomDebounceRef.current = setTimeout(() => {
        doFetchForRegion(track, chrom, start, end, viewLen, type, canvasWidth)
      }, ZOOM_REFETCH_DELAY)
      return
    }

    // Viewport outside overscan — need new data.
    // Cancel any pending zoom refetch since we're doing a real one.
    if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
    if (debounceRef.current) clearTimeout(debounceRef.current)

    // If we have data already, debounce briefly (user is panning).
    // If no data at all, fetch immediately.
    if (hasDataRef.current && f?.chrom === chrom) {
      debounceRef.current = setTimeout(() => {
        doFetchForRegion(track, chrom, start, end, viewLen, type, canvasWidth)
      }, PAN_DEBOUNCE)
    } else {
      doFetchForRegion(track, chrom, start, end, viewLen, type, canvasWidth)
    }

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
    }
  }, [track?.id, region?.chrom, region?.start, region?.end, canvasWidth])

  function doFetchForRegion(track, chrom, start, end, viewLen, type, canvasWidth) {
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

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Only show loading spinner on first load — never blank existing data
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

  return { data, loading, error }
}
