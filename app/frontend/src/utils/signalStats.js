/**
 * signalStats.js — Exact signal statistics of a coverage/read track over a
 * region, from the backend's /stats endpoint. Unlike summarising the drawn
 * bins, the numbers don't depend on the zoom level or the windowing function.
 * Used by the gene hover tooltip and the selected-region tooltip.
 */
import { tracksApi } from '../api/client'

const cache = new Map()   // `${trackId}|${chrom}|${start}|${end}` -> row
const CACHE_MAX = 200

/** Resolves to { trackId, name, covered, mean, max, min, sum, fwdSum, revSum,
 *  strand, complete }, or null when the request fails. `covered` is the number
 *  of bases with data and `mean` the mean over those bases; `sum` counts both
 *  strands for strand data (e.g. Tn-seq insertions). Incomplete results (a BAM
 *  whose coverage is still being computed) are not cached. */
export function fetchSignalStats(track, chrom, start, end, signal) {
  const key = `${track.id}|${chrom}|${start}|${end}`
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  return tracksApi.stats(track.id, chrom, start, end, { signal })
    .then(res => {
      const s = res.data
      if (!s) return null
      // Strand-split figures only when there is a reverse (negative) side
      // here; an unsigned WIG also reports forward/reverse sums (reverse 0).
      const strand = s.forward_sum != null && ((s.reverse_sum || 0) < 0 || (s.min ?? 0) < 0)
      const row = {
        trackId: track.id, name: track.name, covered: s.covered_bp || 0,
        mean: s.mean, max: s.max, min: s.min,
        sum: strand ? s.forward_sum + Math.abs(s.reverse_sum || 0) : s.sum,
        fwdSum: strand ? s.forward_sum : null,
        revSum: strand ? s.reverse_sum : null,
        strand, complete: s.complete !== false,
      }
      if (row.complete) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(key, row)
      }
      return row
    })
    .catch(() => null)
}
