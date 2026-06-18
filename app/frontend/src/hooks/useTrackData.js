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
 * Robustness against rapid zoom/pan:
 *  - Each new fetch aborts the previous one (signal is passed to axios so the
 *    underlying HTTP request is actually cancelled, not just the state update).
 *  - Transient network/server errors (status 0, 5xx) trigger up to 2 silent
 *    retries with exponential backoff before surfacing as `error`.
 *  - Old data is NEVER cleared on error — it stays on screen so the viewer
 *    never "blanks out" mid-zoom, preserving data integrity for the user.
 *  - Errors are cleared automatically when the user changes chromosome or
 *    when a subsequent fetch succeeds.
 */
import { useState, useEffect, useRef } from 'react'
import { tracksApi } from '../api/client'

const READ_DETAIL_THRESHOLD = 50_000
const OVERSCAN = 0.5            // fetch 0.5x extra on each side (2x total)
const PAN_DEBOUNCE = 100
const ZOOM_REFETCH_DELAY = 800
const MAX_RETRIES = 2
const RETRY_BACKOFF_MS = [250, 750]   // delays before retry #1 and #2

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
    deleteByPrefix(prefix) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    },
  }
}
const cache = makeCache()

const liveData = new Map()

function setLiveData(trackId, data) { liveData.set(trackId, data) }

export function getLiveTrackData(trackId) { return liveData.get(trackId) || null }

/** Drop all cached + live data for a track. Called when a track is removed so
 *  stale data can never resurface (e.g. in a re-added track that reuses an id)
 *  and the module-level maps don't grow unbounded across add/remove cycles. */
export function clearTrackData(trackId) {
  liveData.delete(trackId)
  cache.deleteByPrefix(`${trackId}|`)
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

/** Classify a fetch error as transient (worth retrying) or permanent. */
function isTransientError(err) {
  if (!err) return false
  if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return false
  const status = err.response?.status
  // No response → network/connection error, retry.
  if (status === undefined) return true
  // 5xx server errors → retry (especially 502/503/504 which are common
  // when the backend is overwhelmed by rapid zoom/pan).
  if (status >= 500 && status < 600) return true
  // 408 Request Timeout, 429 Too Many Requests
  if (status === 408 || status === 429) return true
  return false
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
  const retryTimerRef = useRef(null)

  // Cleanup on unmount: cancel any in-flight request and pending timers
  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
  }, [])

  useEffect(() => {
    if (!track || !region || !canvasWidth) return
    const { chrom, start, end } = region
    const viewLen = end - start
    const type = track.track_type

    if (fetchedRef.current && fetchedRef.current.trackId !== track.id) {
      fetchedRef.current = null
      hasDataRef.current = false
    }

    // When chromosome changes, drop sticky errors so a stale failure from a
    // previous chrom doesn't follow the user.
    if (fetchedRef.current && fetchedRef.current.chrom !== chrom) {
      setError(null)
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
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }

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
    // Cancel any previous in-flight request — passes signal to axios so the
    // underlying HTTP request is genuinely aborted, not merely suppressed.
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // Only show loading spinner on first load — never blank existing data.
    if (!hasDataRef.current) setLoading(true)
    setError(null)

    // Snapshot the request identity. The retry path checks against this so
    // a backoff-scheduled retry that fires after the user has navigated to
    // a different chrom/track will bail instead of overwriting fresh data
    // with stale results.
    const requestKey = { trackId: track.id, chrom, start, end, viewLen }
    attemptFetchOnce(controller, requestKey, track, chrom, start, end, viewLen, type, canvasWidth, 0)
  }

  function attemptFetchOnce(controller, requestKey, track, chrom, start, end, viewLen, type, canvasWidth, attempt) {
    // Bail if a newer fetch has superseded this one or the hook has unmounted.
    if (controller.signal.aborted) return

    const useOverscan = type !== 'reads' || viewLen > READ_DETAIL_THRESHOLD
    const os = useOverscan ? OVERSCAN : 0
    const fetchStart = Math.max(0, Math.floor(start - viewLen * os))
    const fetchEnd = Math.ceil(end + viewLen * os)
    const ratio = (fetchEnd - fetchStart) / viewLen
    // Cap bins: match backend le=5000 limit, but at least 500 for quality
    const bins = Math.max(500, Math.min(Math.floor(canvasWidth * ratio), 5000))

    const cacheKey = `${track.id}|${type}|${chrom}|${fetchStart}|${fetchEnd}|${bins}`

    // First-attempt only: serve from cache if present.
    // Retries skip the cache — we already know we want a fresh fetch.
    if (attempt === 0) {
      const cached = cache.get(cacheKey)
      if (cached) {
        setData(cached)
        setLiveData(track.id, cached)
        setError(null)
        fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen }
        hasDataRef.current = true
        return
      }
    }

    const opts = { signal: controller.signal }
    let promise
    if (type === 'reads') {
      if (viewLen <= READ_DETAIL_THRESHOLD) {
        promise = tracksApi.reads(track.id, chrom, start, end, opts)
      } else {
        promise = tracksApi.coverage(track.id, chrom, fetchStart, fetchEnd, bins, opts)
      }
    } else if (type === 'coverage') {
      promise = tracksApi.coverage(track.id, chrom, fetchStart, fetchEnd, bins, opts)
    } else if (type === 'variants') {
      promise = tracksApi.variants(track.id, chrom, fetchStart, fetchEnd, opts)
    } else if (type === 'annotations' || type === 'genome_annotations') {
      promise = tracksApi.features(track.id, chrom, fetchStart, fetchEnd, opts)
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
        setLoading(false)
      })
      .catch(err => {
        // Aborted requests: silently drop. Use the captured controller so a
        // retry-loop that started with one controller cannot be misattributed
        // to a later, freshly-created one.
        if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' ||
            controller.signal.aborted) {
          return
        }

        // Transient errors: retry with backoff. The captured controller is
        // shared across all attempts of a single doFetchForRegion call —
        // when a newer fetch supersedes it via abortRef.current.abort(),
        // every pending retry's signal goes aborted and the loop exits.
        if (isTransientError(err) && attempt < MAX_RETRIES) {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
          const delay = RETRY_BACKOFF_MS[attempt] || 1000
          retryTimerRef.current = setTimeout(() => {
            attemptFetchOnce(controller, requestKey, track, chrom, start, end, viewLen, type, canvasWidth, attempt + 1)
          }, delay)
          return
        }

        // Final failure — surface error message but keep cached data on screen.
        const detail = err.response?.data?.detail
        const msg = typeof detail === 'string' ? detail : err.message || String(err)
        setError(msg)
        setLoading(false)
      })
  }

  return { data, loading, error }
}
