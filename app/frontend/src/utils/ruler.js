/**
 * ruler.js — Tick positions and labels for the X-axis ruler, shared by the
 * on-screen RulerTrack and the SVG export so both always agree.
 *
 * Labels carry exactly the precision the tick spacing needs: full
 * comma-grouped positions when ticks are < 1 kb apart (561,050), otherwise k/M
 * units with decimals derived from the spacing (2.002M for 2 kb ticks on a
 * 4 Mb contig). The previous fixed formats (toFixed(1) for k, toFixed(2) for
 * M) repeated one label on every tick at high zoom, and fractional intervals
 * printed float residue such as 100.60000000000001.
 */

/** Label for a tick at `pos` when ticks are `interval` bp apart. */
export function formatTick(pos, interval) {
  if (pos === 0) return '0'
  if (interval < 1000) return Math.round(pos).toLocaleString('en-US')
  if (pos >= 1e6) {
    const d = Math.max(0, Math.ceil(Math.log10(1e6 / interval) - 1e-9))
    return `${(pos / 1e6).toFixed(d)}M`
  }
  const d = Math.max(0, Math.ceil(Math.log10(1e3 / interval) - 1e-9))
  return `${(pos / 1e3).toFixed(d)}k`
}

/** Ticks for the view [start, end) drawn `width` px wide:
 *  { interval, ticks: [{ pos, x, label }] }. Positions are integer multiples
 *  of a 1-2-5 interval (never below 1 bp), computed without float drift. */
export function rulerTicks(start, end, width) {
  const len = end - start
  if (!(len > 0) || !(width > 0)) return { interval: 0, ticks: [] }
  const targetTicks = Math.max(1, Math.min(10, Math.floor(width / 80)))
  const rawInterval = len / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rawInterval)))
  const candidates = [1, 2, 5, 10].map(x => x * mag)
  const chosen = candidates.find(c => c >= rawInterval) || candidates[candidates.length - 1]
  const interval = Math.max(1, Math.round(chosen))
  const ticks = []
  for (let k = Math.ceil(start / interval); k * interval <= end; k++) {
    const pos = k * interval
    ticks.push({ pos, x: ((pos - start) / len) * width, label: formatTick(pos, interval) })
  }
  return { interval, ticks }
}
