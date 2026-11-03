/**
 * useTrackData.js — Data fetching hook for track components.
 *
 * Manages loading/error state and an overscan cache so panning
 * doesn't re-fetch on every pixel. Supports coverage, reads, variants, features.
 *
 * Three fetch strategies:
 * 1. Viewport within overscan, same zoom: skip fetch (cached data is fine;
 *    for a read track, only data of the kind this zoom shows: reads or coverage)
 * 2. Viewport within overscan, different zoom: debounced refetch at the new
 *    resolution (immediate-ish for large jumps such as a gene search)
 * 3. Viewport outside overscan: immediate fetch (pan debounce 100ms, or instant if
 *    no data exists yet)
 *
 * Coverage requests are planned by planCoverageFetch: the range never extends
 * past the chromosome end, and a track's fixed bin size (Track Settings →
 * Bin size) produces genome-aligned bins; Auto keeps ~one bin per pixel.
 *
 * Robustness against rapid zoom/pan:
 *  - Each new fetch aborts the previous one (signal is passed to axios so the
 *    underlying HTTP request is actually cancelled, not just the state update),
 *    and panning back into the already-fetched range aborts a newer fetch for
 *    the abandoned view, so a late response for it can never overwrite the
 *    current one.
 *  - Transient network/server errors (no response, 5xx, 408/409/429) trigger
 *    up to 2 silent retries with exponential backoff before surfacing as
 *    `error`.
 *  - Within a chromosome, old data is never cleared on error — it stays on
 *    screen so the viewer never "blanks out" mid-zoom. On a chromosome switch
 *    the previous chromosome's data is dropped immediately, so it can never
 *    be drawn (or scaled) at the new chromosome's coordinates.
 *  - Coverage that is still being computed (a BAM's background coverage
 *    index) is shown as far as it goes and re-requested until complete: one
 *    poll per track, which pans and resizes inside the fetched range leave
 *    running (and restart if a since-abandoned fetch had stopped it). A poll
 *    still failing after its retries keeps the error on show and polls again
 *    after 3, 6, then 10 s; after 5 failed polls in a row (or a permanent
 *    error) it stops until the next pan or resize inside the fetched range.
 */
import { useState, useEffect, useRef } from 'react'
import { tracksApi } from '../api/client'
import { useBrowser } from '../store/BrowserContext'
import { planCoverageFetch, OVERSCAN } from '../utils/fetchPlan'
import { binExtremes, hasNegativeSide, windowingOf } from '../utils/coverageStats'

export const READ_DETAIL_THRESHOLD = 50_000   // a read track shows individual reads up to this view length
const PAN_DEBOUNCE = 100
const ZOOM_REFETCH_DELAY = 800
const BIG_ZOOM_RATIO = 4           // zoom jumps beyond this refetch at pan speed
const INCOMPLETE_POLL_MS = 1500    // re-ask while a BAM coverage index is building
const POLL_FAIL_BACKOFF_MS = [3000, 6000, 10000]   // next poll after failed poll #1, #2, #3 and on
const POLL_MAX_FAILS = 5           // failed polls in a row before the poll stops
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

// ── Live-data change subscription ──────────────────────────────────
// liveData is a plain module Map, so writing track B's data re-renders only
// B's own component. Tracks that derive their Y axis from SIBLINGS (overlay
// groups and linked scales) must also re-render when a sibling's data arrives,
// otherwise they stay drawn at a stale shared max until the next pan/zoom.
// They subscribe here and bump a version included in their draw deps.
let liveDataVersion = 0
const liveDataListeners = new Set()
function notifyLiveDataChange() {
  liveDataVersion++
  for (const fn of liveDataListeners) fn(liveDataVersion)
}

function setLiveData(trackId, data) { liveData.set(trackId, data); notifyLiveDataChange() }

export function getLiveTrackData(trackId) { return liveData.get(trackId) || null }

/** Subscribe to ANY live-data change. Pass active=false to opt out (standalone
 *  tracks don't depend on siblings, so they skip the extra re-renders). Returns
 *  a monotonically increasing version to feed into an effect dependency list. */
export function useLiveDataVersion(active) {
  const [v, setV] = useState(liveDataVersion)
  useEffect(() => {
    if (!active) return undefined
    const fn = (nv) => setV(nv)
    liveDataListeners.add(fn)
    setV(liveDataVersion)   // resync in case data changed between render and effect
    return () => { liveDataListeners.delete(fn) }
  }, [active])
  return active ? v : 0
}

/** Drop all cached + live data for a track. Called when a track is removed so
 *  stale data can never resurface (e.g. in a re-added track that reuses an id)
 *  and the module-level maps don't grow unbounded across add/remove cycles. */
export function clearTrackData(trackId) {
  liveData.delete(trackId)
  cache.deleteByPrefix(`${trackId}|`)
  notifyLiveDataChange()
}

export function getCachedDataForTrack(trackId, chrom) {
  const live = liveData.get(trackId)
  if (live && (!live.chrom || live.chrom === chrom)) return live
  return cache.findByPrefix(`${trackId}|coverage|${chrom}|`)
    || cache.findByPrefix(`${trackId}|reads|${chrom}|`)
    || cache.findByPrefix(`${trackId}|annotations|${chrom}|`)
    || cache.findByPrefix(`${trackId}|genome_annotations|${chrom}|`)
    || cache.findByPrefix(`${trackId}|variants|${chrom}|`)
    || null
}

/** True when `t` is shown on `chrom` (visible and targeting that chromosome). */
function isActiveOn(t, chrom) {
  if (t.visible === false) return false
  return !t.targetChromosomes || !chrom || t.targetChromosomes.includes(chrom)
}

/** The tracks whose data shares `track`'s Y axis: its overlay group, else its
 *  link group (tracks carrying the same linkScale id), else just itself.
 *  Hidden members and members not shown on this chromosome are excluded —
 *  their frozen data must not steer the axis of the tracks still on screen. */
export function scaleGroup(track, region, tracks) {
  let group = [track]
  if (Array.isArray(tracks)) {
    if (track.overlayGroup) {
      group = tracks.filter(t => t.overlayGroup === track.overlayGroup)
    } else if (track.linkScale) {
      group = tracks.filter(t => (t.track_type === 'coverage' || t.track_type === 'reads') && t.linkScale === track.linkScale)
    }
  }
  const chrom = region?.chrom
  const active = group.filter(t => t.id === track.id || isActiveOn(t, chrom))
  return active.length ? active : [track]
}

/** Live data for a track if it belongs to `chrom` (never another chromosome's). */
function liveFor(t, chrom) {
  const d = liveData.get(t.id)
  if (!d || (chrom && d.chrom && d.chrom !== chrom)) return null
  return d
}

/** Compute the auto Y-scale (max/min) for a coverage/read track.
 *
 *  Every member is summarised with ITS windowing function (Max — the default,
 *  peak-preserving — or Mean), the same statistic its bars are drawn with, so
 *  the axis describes exactly what is on screen.
 *   - autoScaleVisible (default on): only bins inside the visible region
 *     [region.start, region.end), so the axis fits what you see and re-fits as
 *     you pan. Off: the whole fetched range (view ±50%), which keeps the axis
 *     steadier while panning at the cost of off-screen peaks setting it.
 *   - Overlay / link groups share one axis: the union of their visible members
 *     (fit-to-visible applies when any member has it on).
 *  Returns { max, min } in data units. */
export function computeAutoScale(track, region, tracks) {
  const members = scaleGroup(track, region, tracks)
  const visible = members.some(m => m.autoScaleVisible !== false) && region
  const lo = visible ? region.start : -Infinity
  const hi = visible ? region.end : Infinity
  let maxV = 0, minV = 0
  for (const t of members) {
    const d = liveFor(t, region?.chrom)
    if (!d || !d.bins?.length) continue
    const e = binExtremes(d.bins, windowingOf(t), lo, hi)
    if (e.max > maxV) maxV = e.max
    if (e.min < minV) minV = e.min
  }
  return { max: maxV, min: minV }
}

/** Whether `track` needs the split (forward up / reverse down) layout. Decided
 *  from the backend's chromosome-wide `has_negative` when available, so the
 *  layout doesn't flip as you pan sparse signed data; group-wide for overlay
 *  and link groups so every member uses the same coordinate system. */
export function needsSplitLayout(track, region, tracks) {
  for (const t of scaleGroup(track, region, tracks)) {
    const d = liveFor(t, region?.chrom)
    if (!d) continue
    if (d.has_negative != null ? d.has_negative : hasNegativeSide(d.bins, windowingOf(t))) return true
  }
  return false
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
  // 408 Request Timeout, 429 Too Many Requests, 409 superseded by a newer
  // request for the same track (normally one this client already aborted)
  if (status === 408 || status === 409 || status === 429) return true
  return false
}

export function useTrackData(track, region, canvasWidth) {
  const { genome } = useBrowser()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)     // controller of the newest fetch, shared by its retries and polls
  // The data on screen: { trackId, chrom, start, end, viewLen, binSize,
  // readMode (reads rather than coverage), complete, controller (of the fetch
  // that produced it), req (its request), and while incomplete: pollFails
  // (failed polls in a row), pollStopped }
  const fetchedRef = useRef(null)
  const debounceRef = useRef(null)
  const zoomDebounceRef = useRef(null)
  const hasDataRef = useRef(false)
  const retryTimerRef = useRef(null)
  const pollTimerRef = useRef(null)
  const latestRef = useRef(null)    // newest request parameters (timers read these)

  const chromLength = (region && genome?.chromosomes?.find(c => c.name === region.chrom)?.length) || 0
  const binSize = track && track.binSize > 0 ? track.binSize : null

  // Cleanup on unmount: cancel any in-flight request and pending timers
  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort()
    for (const r of [debounceRef, zoomDebounceRef, retryTimerRef, pollTimerRef]) {
      if (r.current) clearTimeout(r.current)
    }
  }, [])

  useEffect(() => {
    if (!track || !region || !canvasWidth) return
    const { chrom, start, end } = region
    const viewLen = end - start
    const type = track.track_type
    latestRef.current = { track, chrom, start, end, viewLen, type, canvasWidth, chromLength, binSize }

    if (fetchedRef.current && fetchedRef.current.trackId !== track.id) {
      fetchedRef.current = null
      hasDataRef.current = false
    }

    // Chromosome switch: drop the previous chromosome's data at once (it must
    // never be drawn or scaled at the new coordinates), and any sticky error.
    if (fetchedRef.current && fetchedRef.current.chrom !== chrom) {
      if (abortRef.current) abortRef.current.abort()
      fetchedRef.current = null
      hasDataRef.current = false
      liveData.delete(track.id)
      notifyLiveDataChange()
      setData(null)
      setError(null)
    }

    const f = fetchedRef.current
    // A read track's data must also be of the kind this zoom shows (reads up
    // to READ_DETAIL_THRESHOLD, coverage beyond): a small zoom-in from
    // coverage lands inside its overscan, yet needs reads.
    const readMode = type === 'reads' && viewLen <= READ_DETAIL_THRESHOLD
    const withinOverscan = f && f.trackId === track.id && f.chrom === chrom &&
      start >= f.start && end <= f.end && f.binSize === binSize && f.readMode === readMode

    if (withinOverscan) {
      const zoomRatio = viewLen / (f.viewLen || viewLen)
      // Reads are fetched for exactly the view, with its counts (total, read
      // limit): a small zoom-in still needs them for the new view.
      if (zoomRatio > 0.8 && zoomRatio < 1.2 && (!readMode || (start === f.start && end === f.end))) {
        // Same zoom, within the fetched range — nothing to load. A newer fetch
        // still pending (e.g. for a pan that was abandoned by panning back) is
        // for a view we no longer show: cancel it so it can't overwrite this
        // data. The fetch that produced the data on screen is left alone:
        // while that data is incomplete it is polling for the rest.
        if (zoomDebounceRef.current) { clearTimeout(zoomDebounceRef.current); zoomDebounceRef.current = null }
        if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
        if (abortRef.current && abortRef.current !== f.controller) {
          if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
          abortRef.current.abort()
        }
        // That poll stopped — a fetch for another view cancelled it when it
        // started, or it kept failing: resume it.
        if (!f.complete && (f.controller.signal.aborted || f.pollStopped)) resumePoll(f)
        return
      }
      // Zoom changed but still within overscan — schedule a resolution refetch,
      // keeping the current data on screen. Big jumps (gene search, typed
      // locus) refetch at pan speed; the timer is not restarted by every
      // further move, so dragging cannot postpone it indefinitely.
      const big = zoomRatio < 1 / BIG_ZOOM_RATIO || zoomRatio > BIG_ZOOM_RATIO
      if (!zoomDebounceRef.current || big) {
        if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current)
        zoomDebounceRef.current = setTimeout(() => {
          zoomDebounceRef.current = null
          fetchLatest()
        }, big ? PAN_DEBOUNCE : ZOOM_REFETCH_DELAY)
      }
      return
    }

    // Viewport outside overscan — need new data.
    // Cancel any pending zoom refetch since we're doing a real one.
    if (zoomDebounceRef.current) { clearTimeout(zoomDebounceRef.current); zoomDebounceRef.current = null }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (retryTimerRef.current) {
      // Dropping a pending retry ends its fetch: abort it, so that a poll it
      // belonged to reads as stopped (and resumes if the view comes back).
      clearTimeout(retryTimerRef.current); retryTimerRef.current = null
      if (abortRef.current) abortRef.current.abort()
    }

    // If we have data already, debounce briefly (user is panning).
    // If no data at all, fetch immediately.
    if (hasDataRef.current && f?.chrom === chrom) {
      debounceRef.current = setTimeout(() => { debounceRef.current = null; fetchLatest() }, PAN_DEBOUNCE)
    } else {
      fetchLatest()
    }

    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
    }
  }, [track?.id, region?.chrom, region?.start, region?.end, canvasWidth, chromLength, binSize])

  /** Fetch for the newest requested view (timers may fire after several moves). */
  function fetchLatest() {
    if (latestRef.current) doFetchForRegion(latestRef.current)
  }

  /** `req`: { track, chrom, start, end, viewLen, type, canvasWidth, chromLength, binSize } */
  function doFetchForRegion(req) {
    // Cancel any previous in-flight request — passes signal to axios so the
    // underlying HTTP request is genuinely aborted, not merely suppressed.
    if (abortRef.current) abortRef.current.abort()
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
    const controller = new AbortController()
    abortRef.current = controller

    // Only show loading spinner on first load — never blank existing data.
    if (!hasDataRef.current) setLoading(true)
    setError(null)

    attemptFetchOnce(controller, req, 0)
  }

  /** Ask again after `delay` for incomplete data (the backend is still
   *  building a BAM's exact coverage). The track's only poll: arming replaces
   *  any other. */
  function schedulePoll(controller, req, delay = INCOMPLETE_POLL_MS) {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null
      if (abortRef.current === controller && !controller.signal.aborted) attemptFetchOnce(controller, req, 0, true)
    }, delay)
  }

  /** Poll again for the incomplete data on screen `f`, whose poll stopped: a
   *  fetch for another view cancelled it (that fetch has been cancelled
   *  since), or it failed too often. The resumed poll starts afresh. */
  function resumePoll(f) {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    fetchedRef.current = { ...f, controller, pollFails: 0, pollStopped: false }
    schedulePoll(controller, f.req)
  }

  /** A poll for the incomplete data on screen failed, retries included; its
   *  error stays on show. After a transient failure, poll again after a
   *  growing pause, up to POLL_MAX_FAILS failed polls in a row; then, or at
   *  once after a permanent error, stop and mark the data so that the next
   *  pan or resize inside the fetched range resumes the poll. */
  function pollFailed(controller, req, transient) {
    const f = fetchedRef.current
    if (!f || f.controller !== controller || f.complete) return
    const fails = (f.pollFails || 0) + 1
    const again = transient && fails < POLL_MAX_FAILS
    fetchedRef.current = { ...f, pollFails: fails, pollStopped: !again }
    if (again) schedulePoll(controller, req, POLL_FAIL_BACKOFF_MS[Math.min(fails, POLL_FAIL_BACKOFF_MS.length) - 1])
  }

  /** `attempt`: retries so far. `poll`: a poll for the incomplete data on
   *  screen (never served from the cache; see pollFailed for its failures). */
  function attemptFetchOnce(controller, req, attempt, poll = false) {
    // Bail if a newer fetch has superseded this one or the hook has unmounted.
    if (controller.signal.aborted) return
    const { track, chrom, start, end, viewLen, type, canvasWidth, chromLength, binSize } = req

    const readMode = type === 'reads' && viewLen <= READ_DETAIL_THRESHOLD
    const useOverscan = !readMode
    let plan
    if (type === 'coverage' || (type === 'reads' && !readMode)) {
      plan = planCoverageFetch({ start, end, chromLength, canvasWidth, binSize, overscan: OVERSCAN })
    } else {
      const os = useOverscan ? OVERSCAN : 0
      const fs = Math.max(0, Math.floor(start - viewLen * os))
      let fe = Math.ceil(end + viewLen * os)
      if (chromLength > 0) fe = Math.min(fe, chromLength)
      plan = { fetchStart: fs, fetchEnd: Math.max(fe, fs + 1), bins: 0, binSize: null, requestedBinSize: null, capped: false }
    }
    const { fetchStart, fetchEnd, bins } = plan

    const cacheKey = `${track.id}|${type}|${chrom}|${fetchStart}|${fetchEnd}|${bins}`

    // First attempt of a fetch only: serve from cache if present. Retries and
    // polls skip the cache — we already know we want a fresh fetch.
    if (attempt === 0 && !poll) {
      const cached = cache.get(cacheKey)
      if (cached) {
        setData(cached)
        setLiveData(track.id, cached)
        setError(null)
        setLoading(false)
        fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen, binSize, readMode, complete: true, controller, req }
        hasDataRef.current = true
        return
      }
    }

    const opts = { signal: controller.signal }
    let promise
    if (type === 'reads' && readMode) {
      promise = tracksApi.reads(track.id, chrom, start, end, opts)
    } else if (type === 'coverage' || type === 'reads') {
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
        // A response for another chromosome than the one now shown is stale.
        if (latestRef.current && latestRef.current.chrom !== chrom) return
        const result = {
          ...res.data,
          mode: readMode ? 'reads' : 'coverage',
          // What the bins actually are — shown by Track Settings → Bin size.
          plan: { binSize: plan.binSize, requestedBinSize: plan.requestedBinSize, capped: plan.capped },
        }
        const incomplete = result.complete === false
        if (!incomplete) cache.set(cacheKey, result)
        fetchedRef.current = { trackId: track.id, chrom, start: fetchStart, end: fetchEnd, viewLen, binSize, readMode, complete: !incomplete, controller, req }
        hasDataRef.current = true
        setData(result)
        setLiveData(track.id, result)
        setError(null)
        setLoading(false)
        // The backend is still building this BAM's exact coverage: show what
        // is done and ask again shortly (while this data stays on screen).
        if (incomplete) schedulePoll(controller, req)
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
            retryTimerRef.current = null
            attemptFetchOnce(controller, req, attempt + 1, poll)
          }, delay)
          return
        }

        // Final failure — surface error message but keep cached data on screen.
        const detail = err.response?.data?.detail
        const msg = typeof detail === 'string' ? detail : err.message || String(err)
        setError(msg)
        setLoading(false)
        if (poll) pollFailed(controller, req, isTransientError(err))
      })
  }

  // Never hand a component data for another chromosome than the one it shows.
  const shown = data && region && data.chrom && data.chrom !== region.chrom ? null : data
  return { data: shown, loading, error }
}
