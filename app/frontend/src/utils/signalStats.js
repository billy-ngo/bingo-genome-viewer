/**
 * signalStats.js — Exact signal statistics of a coverage/read track over a
 * region, from the backend's /stats endpoint. Unlike summarising the drawn
 * bins, the numbers don't depend on the zoom level or the windowing function.
 * Used by the gene hover tooltip and the selected-region tooltip.
 *
 * Answers are cached per track and region and shared by every asker, so a row
 * carries the track's id but no display name: whoever shows it labels it
 * with its own track object.
 */
import { tracksApi } from '../api/client'

const cache = new Map()   // `${trackId}|${chrom}|${start}|${end}` -> row
const CACHE_MAX = 200
const SLOW_MS = 1000      // a scan running this long stops holding the queue
const RETRY_409_MS = 250  // wait before asking again after a 409 (see fetchSignalStats)
const RETRIES_409 = 3

// A newer /stats request of a slot supersedes an older one the backend still
// has waiting. Suffixing the slot with this page's id keeps another tab on the
// same server from superseding this page's requests (and this page theirs).
const PAGE_ID = Math.random().toString(36).slice(2, 10) || 'page'

const keyOf = (track, chrom, start, end) => `${track.id}|${chrom}|${start}|${end}`

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('canceled')) }, { once: true })
})

// The backend's /stats scans are CPU-bound and share one Python interpreter,
// so asking for several tracks at once (the hover tooltip and every track's
// selection tooltip do) only slows them — and every other request, such as
// the reference bases and coverage — down. They run one at a time instead,
// which finishes the set as fast. A scan still running after SLOW_MS (e.g. a
// BAM counted live) lets the next one start; abandoned requests never go out.
const queue = []   // { run, resolve, reject, signal } not started yet
let fresh = 0      // requests started less than SLOW_MS ago and still running

function pump() {
  while (fresh === 0 && queue.length) {
    const job = queue.shift()
    fresh++
    let counted = true
    const release = () => { if (counted) { counted = false; fresh--; pump() } }
    const timer = setTimeout(release, SLOW_MS)
    Promise.resolve().then(job.run).then(job.resolve, job.reject)
      .finally(() => { clearTimeout(timer); release() })
  }
}

function enqueue(run, signal) {
  return new Promise((resolve, reject) => {
    const cancelled = () => Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })
    if (signal?.aborted) { reject(cancelled()); return }
    const job = { run, resolve, reject, signal }
    queue.push(job)
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(job)
      if (i >= 0) { queue.splice(i, 1); reject(cancelled()) }
    }, { once: true })
    pump()
  })
}

/** The row already known for these coordinates (no request), or undefined. */
export function cachedSignalStats(track, chrom, start, end) {
  return cache.get(keyOf(track, chrom, start, end))
}

/** Resolves to { trackId, covered, mean, max, min, sum, fwdSum, revSum,
 *  strand, complete, truncated, coverageState }, to null when the request
 *  fails, or to undefined when it stayed superseded (HTTP 409) by a newer
 *  request of the same `opts.slot` for the track: its caller ignores that and
 *  waits for the newer request's answer. Only `track.id` is used. `covered`
 *  is the number of bases with data and `mean` the mean over those bases;
 *  `sum` counts both strands for strand data (e.g. Tn-seq insertions).
 *   - complete false: still being computed (a BAM whose coverage index is
 *     building) — ask again later. Such rows are not cached.
 *   - truncated true: no exact value can be had (a BAM without a coverage
 *     index, with too many reads to count live); the numbers are null.
 *  opts: { signal, slot } */
export function fetchSignalStats(track, chrom, start, end, opts = {}) {
  const key = keyOf(track, chrom, start, end)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const slot = opts.slot ? `${opts.slot}-${PAGE_ID}` : undefined
  const attempt = (left) => enqueue(() => tracksApi.stats(track.id, chrom, start, end, { signal: opts.signal, slot }), opts.signal)
    .then(res => {
      const s = res.data
      if (!s) return null
      const truncated = s.truncated === true
      // Strand-split figures only when there is a reverse (negative) side
      // here; an unsigned WIG also reports forward/reverse sums (reverse 0).
      const strand = !truncated && s.forward_sum != null && ((s.reverse_sum || 0) < 0 || (s.min ?? 0) < 0)
      const row = {
        trackId: track.id, covered: s.covered_bp || 0,
        mean: s.mean, max: s.max, min: s.min,
        sum: strand ? s.forward_sum + Math.abs(s.reverse_sum || 0) : s.sum,
        fwdSum: strand ? s.forward_sum : null,
        revSum: strand ? s.reverse_sum : null,
        strand, complete: s.complete !== false,
        truncated, coverageState: s.coverage_state ?? null,
      }
      if (row.complete) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(key, row)
      }
      return row
    })
    .catch(err => {
      if (err?.response?.status !== 409) return null
      // This page aborts a request before it sends the one replacing it, so
      // a 409 for a request still wanted means an earlier, aborted one reached
      // the backend after it: ask again.
      if (left <= 0 || opts.signal?.aborted) return undefined
      return wait(RETRY_409_MS, opts.signal).then(() => attempt(left - 1), () => undefined)
    })
  return attempt(RETRIES_409)
}
