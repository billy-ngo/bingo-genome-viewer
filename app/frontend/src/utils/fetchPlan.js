/** Coverage fetch planning: which range to request and how to bin it. */

export const OVERSCAN = 0.5          // fetch 0.5x extra on each side (2x total)
export const MAX_BINS = 5000         // client-side cap (the backend accepts up to 10000)
export const MIN_AUTO_BINS = 500

/**
 * Plan a coverage request for the view [start, end).
 *  - Auto (binSize null): ~one bin per screen pixel over the overscanned range.
 *  - Fixed binSize (bp): bins aligned to genomic multiples of the size, so they
 *    don't shift while panning; when that would exceed MAX_BINS the size is
 *    coarsened to the smallest multiple that fits (capped=true).
 * The range never extends past the chromosome end (when chromLength is known).
 * Returns { fetchStart, fetchEnd, bins, binSize, requestedBinSize, capped }.
 */
export function planCoverageFetch({ start, end, chromLength, canvasWidth, binSize, overscan = OVERSCAN }) {
  const viewLen = Math.max(1, end - start)
  const fs = Math.max(0, Math.floor(start - viewLen * overscan))
  let fe = Math.ceil(end + viewLen * overscan)
  if (chromLength > 0) fe = Math.min(fe, chromLength)
  if (fe <= fs) fe = fs + 1

  const req = binSize > 0 ? Math.max(1, Math.round(binSize)) : null
  if (req) {
    let eff = req
    for (;;) {
      const afs = Math.floor(fs / eff) * eff
      const afe = Math.ceil(fe / eff) * eff
      const n = (afe - afs) / eff
      if (n <= MAX_BINS) {
        return { fetchStart: afs, fetchEnd: afe, bins: n, binSize: eff, requestedBinSize: req, capped: eff !== req }
      }
      eff = req * Math.max(eff / req + 1, Math.ceil((fe - fs) / (req * MAX_BINS)))
    }
  }
  const ratio = (fe - fs) / viewLen
  const want = Math.max(MIN_AUTO_BINS, Math.min(Math.floor(canvasWidth * ratio), MAX_BINS))
  const n = Math.min(want, fe - fs)            // the backend never makes bins smaller than 1 bp
  return { fetchStart: fs, fetchEnd: fe, bins: n, binSize: (fe - fs) / n, requestedBinSize: null, capped: false }
}
