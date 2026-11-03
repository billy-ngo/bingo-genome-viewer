/**
 * FileLoader.jsx — Unified file upload panel.
 *
 * A single file picker accepts all supported file types. Files are
 * automatically classified as genome or track by extension. If a genome
 * file is selected when one is already loaded, the user is prompted to
 * add it as a new chromosome, load it as a track, or skip it.
 *
 * BAM files require a .bai index — when both are selected together the
 * index is automatically paired and uploaded alongside the BAM.
 *
 * Every interactive track load (uploads, the path box, the large-file path
 * dialog) checks the track against the genome first, and names any genome
 * chromosome it pairs with a differently named contig by length alone.
 */
import React, { useState, useRef, useEffect } from 'react'
import { genomeApi, tracksApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'

function isTrackMismatch(info) {
  const c = info?.compatibility
  return c && c.status !== 'ok' && c.status !== 'no_genome'
}
import { useTheme } from '../../store/ThemeContext'

/** How long a length-pairing notice stays up (like the conversion hints). */
export const PAIRING_NOTICE_MS = 8000

function shortName(name, max = 32) {
  return name.length > max ? `${name.slice(0, max - 1)}\u2026` : name
}

/** A name cut to `max` characters in the middle, keeping its end: track file
 *  names often share a long prefix and differ only towards the end. */
function midName(name, max = 32) {
  if (name.length <= max) return name
  const tail = Math.ceil((max - 1) * 0.6)
  return `${name.slice(0, max - 1 - tail)}\u2026${name.slice(-tail)}`
}

/**
 * A notice naming the genome chromosomes that tracks show with a differently
 * named contig because their lengths match exactly, from objects carrying a
 * `compatibility` (track load responses, tracks, pairingChanges().paired):
 * `{ text, title }`, or null when there are none. That is how a GenBank LOCUS
 * name finds the accession its BAMs and BigWigs were aligned to, but between
 * unrelated assemblies the same match can be a coincidence, so the pairing is
 * never made silently. `text` names the first pair (and how many more there
 * are, over all the tracks), `title` lists them in full.
 */
export function lengthPairingNotice(infos) {
  const pairs = new Map()
  const unlisted = new Map()   // per listing: how many pairs are past it
  for (const info of infos || []) {
    const c = info?.compatibility
    const listed = c?.aliases || []
    for (const a of listed) pairs.set(`${a.genome}\u0000${a.track}`, a)
    // A response lists the first pairs only (aliases_total counts them all),
    // and pairs past a listing can't be told apart across tracks: tracks
    // listing the same pairs out of the same total are taken to share the
    // rest too (one assembly), other tracks to share none of it.
    const rest = (c?.aliases_total || 0) - listed.length
    if (rest > 0) unlisted.set(`${c.aliases_total}\u0001${listed.map(a => `${a.genome}\u0000${a.track}`).join('\u0001')}`, rest)
  }
  if (!pairs.size) return null
  const list = [...pairs.values()]
  const fmt = (a, short) => `${short ? shortName(a.genome) : a.genome} \u2194 ${short ? shortName(a.track) : a.track}` +
    ` (${(a.length || 0).toLocaleString()} bp)`
  const more = list.length + [...unlisted.values()].reduce((n, k) => n + k, 0) - 1
  const tail = more > 0 ? ` and ${more.toLocaleString()} more` : ''
  return {
    text: `Matched by length: ${fmt(list[0], true)}${tail}`,
    title: ['Genome chromosome \u2194 track contig, paired because their lengths match exactly:',
      ...list.slice(0, 10).map(a => fmt(a, false)),
      ...(more > 9 ? [`and ${(more - 9).toLocaleString()} more`] : [])].join('\n'),
  }
}

/**
 * The data tracks a merge's pairings are to be compared with (pairingChanges):
 * `before`, those listed when it started as they were then, plus the tracks
 * in `now` committed since, as they are (their load answered meanwhile).
 */
export function mergeBaseline(before, now) {
  const ids = new Set(before.map(t => t.id))
  return [...before, ...now.filter(t => t.track_type !== 'genome_annotations' && !ids.has(t.id))]
}

/**
 * What merging chromosomes changed for the tracks `before` (as they were
 * before the merge; mergeBaseline), given the latest add-chromosomes
 * `pairings` and the genome's chromosome names before the merge
 * (`oldChroms`, a Set):
 *  - lost: tracks shown on some chromosome before and on none now (with their
 *    new compatibility), for lostPairingWarning: a BAM or BigWig whose only
 *    pairing was by a length the merge made ambiguous;
 *  - moved: tracks taken off chromosomes they were shown on but shown on
 *    others (`{ name, from, to }`), for movedTracksNotice: their data is served
 *    there now, e.g. by name on an added accession instead of by length on a
 *    GenBank LOCUS name; and tracks an earlier merge left on no chromosome
 *    that pair with one again (`from` empty);
 *  - paired: per track, the length-only pairings new to added chromosomes, in
 *    the shape lengthPairingNotice takes.
 * Judged on the target chromosomes rather than the compatibility status: a
 * single-contig BED or WIG that matched a one-chromosome genome reports a
 * mismatch once a merge adds a second chromosome, yet shows the same data.
 */
export function pairingChanges(before, pairings, oldChroms) {
  const lost = []
  const moved = []
  const paired = []
  for (const t of before) {
    const p = pairings?.[t.id]
    if (!p) continue
    const next = p.target_chromosomes || []
    if (t.targetChromosomes) {
      const now = new Set(next)
      const was = t.targetChromosomes.filter(c => oldChroms.has(c))
      const from = was.filter(c => !now.has(c))
      if (was.length && !next.length) lost.push({ ...t, compatibility: p.compatibility })
      else if (from.length || (!was.length && next.length)) moved.push({ name: t.name, from, to: next })
    }
    const had = new Set((t.compatibility?.aliases || []).map(a => `${a.genome}\u0000${a.track}`))
    const listed = p.compatibility?.aliases || []
    const fresh = listed.filter(a => !oldChroms.has(a.genome) && !had.has(`${a.genome}\u0000${a.track}`))
    if (fresh.length) {
      // The pairs are listed in genome order up to a limit, and the added
      // chromosomes come last: once the listing reaches them, the pairs past
      // it are on added chromosomes too.
      const total = p.compatibility.aliases_total || 0
      const unlisted = total > listed.length && !oldChroms.has(listed[listed.length - 1].genome)
        ? total - listed.length : 0
      paired.push({ compatibility: { aliases: fresh, ...(unlisted ? { aliases_total: fresh.length + unlisted } : {}) } })
    }
  }
  return { lost, moved, paired }
}

/** Chromosome names for a notice: the first `max` (shortened unless `full`),
 *  then how many more. */
function chromList(names, max = 2, full = false) {
  const listed = names.slice(0, max).map(n => full ? n : shortName(n, 24)).join(', ')
  return names.length > max ? `${listed} and ${(names.length - max).toLocaleString()} more` : listed
}

/**
 * A notice naming the tracks a merge moved to other chromosomes, or showed
 * again after an earlier merge left them on none (pairingChanges().moved):
 * `{ text, title }`, or null when there are none.
 */
export function movedTracksNotice(moved) {
  if (!moved.length) return null
  const m = moved[0]
  return {
    text: moved.length > 1
      ? `${moved.length} tracks now show on other chromosomes: ` +
        `${moved.slice(0, 3).map(x => midName(x.name, 24)).join(', ')}${moved.length > 3 ? ', …' : ''}`
      : m.from.length
        ? `${midName(m.name)} now shows on ${chromList(m.to)} instead of ${chromList(m.from)}`
        : `${midName(m.name)} shows again, on ${chromList(m.to)}`,
    title: ['Adding chromosomes moved these tracks to the chromosomes their data pairs with now:',
      ...moved.slice(0, 10).map(x => `${x.name}: ${x.from.length ? chromList(x.from, 5, true) : 'no chromosome'} → ${chromList(x.to, 5, true)}`),
      ...(moved.length > 10 ? [`and ${(moved.length - 10).toLocaleString()} more`] : [])].join('\n'),
  }
}

/** The warning for tracks a merge left without a match (pairingChanges), or null. */
export function lostPairingWarning(lost) {
  if (!lost.length) return null
  const names = lost.map(t => t.name).join(', ')
  const why = lost[0].compatibility?.message
  return `After adding chromosomes, ${names} ${lost.length > 1 ? 'no longer match' : 'no longer matches'} the genome` +
    (why ? ` (${lost.length > 1 ? `${lost[0].name}: ` : ''}${why})` : '') + '.'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const GENOME_EXTS = new Set(['.gb', '.gbk', '.genbank', '.fasta', '.fa'])
const GENBANK_EXTS = new Set(['.gb', '.gbk', '.genbank'])   // the genome files that can be a track
const TRACK_EXTS = new Set([
  '.bam', '.bw', '.bigwig',
  '.wig', '.wig.gz',
  '.bedgraph', '.bedgraph.gz', '.bdg', '.bdg.gz',
  '.vcf', '.vcf.gz',
  '.bed', '.gtf', '.gff', '.gff2', '.gff3',
])
const INDEX_EXTS = new Set(['.bai'])
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024  // 50 MB — prompt path instead of uploading

function getFileExt(name) {
  if (!name) return ''
  const lower = name.toLowerCase()
  // Compound extensions — must check before the last-dot fallback,
  // otherwise .wig.gz / .vcf.gz files dispatch as plain ".gz" and
  // get rejected as unsupported.
  if (lower.endsWith('.vcf.gz')) return '.vcf.gz'
  if (lower.endsWith('.wig.gz')) return '.wig.gz'
  if (lower.endsWith('.bedgraph.gz')) return '.bedgraph.gz'
  if (lower.endsWith('.bdg.gz')) return '.bdg.gz'
  if (lower.endsWith('.bam.bai')) return '.bam.bai'
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

/** True for index files (.bai, .bam.bai) */
function isIndexFile(name) {
  const ext = getFileExt(name)
  return ext === '.bai' || ext === '.bam.bai'
}

/**
 * Given a list of selected Files, pair each .bam with its .bai index
 * (if present) and return { trackFiles: [{file, indexFile?}], ... }.
 */
function classifyFiles(files) {
  const genomeFiles = []
  const bamFiles = []
  const indexFiles = []
  const otherTrackFiles = []
  const unknownFiles = []
  const largeFiles = []  // files over threshold — need path dialog

  for (const f of files) {
    const ext = getFileExt(f.name)
    if (GENOME_EXTS.has(ext)) {
      genomeFiles.push(f)
    } else if (ext === '.bam') {
      bamFiles.push(f)
    } else if (isIndexFile(f.name)) {
      indexFiles.push(f)
    } else if (TRACK_EXTS.has(ext)) {
      // Check if file is too large for upload
      if (f.size > LARGE_FILE_THRESHOLD) {
        largeFiles.push(f)
      } else {
        otherTrackFiles.push(f)
      }
    } else {
      unknownFiles.push(f)
    }
  }

  // ALL BAM files go through the pairing dialog (they always need .bai)
  const trackEntries = []
  const unpairedBams = []
  for (const bam of bamFiles) {
    const baseName = bam.name.replace(/\.bam$/i, '')
    const paired = indexFiles.find(idx => {
      const idxName = idx.name.toLowerCase()
      return idxName === bam.name.toLowerCase() + '.bai' || idxName === baseName.toLowerCase() + '.bai'
    })
    if (paired) {
      // Even paired BAMs go through dialog if large
      if (bam.size > LARGE_FILE_THRESHOLD) {
        largeFiles.push(bam)
      } else {
        trackEntries.push({ file: bam, indexFile: paired })
      }
      const i = indexFiles.indexOf(paired)
      if (i !== -1) indexFiles.splice(i, 1)
    } else {
      unpairedBams.push(bam)
    }
  }

  // Non-BAM tracks have no index
  for (const f of otherTrackFiles) {
    trackEntries.push({ file: f, indexFile: null })
  }

  // Remaining unpaired .bai files — give a specific message
  for (const f of indexFiles) {
    f._indexOrphan = true
  }
  unknownFiles.push(...indexFiles)

  return { genomeFiles, trackEntries, unpairedBams, largeFiles, unknownFiles }
}

/**
 * `mergeSignal` counts the merges started from a page drop (App), and
 * `onMergeStart` is called when one starts here: either way the pairing
 * notices and errors on screen, here or in App's drop toast, may no longer
 * hold.
 */
export default function FileLoader({ mergeSignal = 0, onMergeStart }) {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const {
    uploadTrack, commitTrack, discardTrack, addGenomeAnnotationTrack, applyMerge, withPairing, pairingVersion,
    getTracks, error: trackError, setError,
  } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatusLine] = useState(null)
  const statusTimer = useRef(null)
  const [notices, setNotices] = useState([]) // [{ text, title }] — length-only chromosome pairings, tracks a merge moved
  const noticeTimer = useRef(null)
  const [progress, setProgress] = useState(null) // { percent, loaded, total, label }
  const [prompt, setPrompt] = useState(null) // { files: File[] }
  const [trackMismatch, setTrackMismatch] = useState(null) // { tracks: [...] }
  const [bamPrompt, setBamPrompt] = useState(null) // { bamFile, indexFile, bamPath, indexPath, error }
  const [pathText, setPathText] = useState('')
  const [showPathInput, setShowPathInput] = useState(false)
  const inputRef = useRef(null)
  const bamPickerRef = useRef(null)
  const baiPickerRef = useRef(null)

  const ALL_ACCEPT = [
    ...Array.from(GENOME_EXTS),
    ...Array.from(TRACK_EXTS),
    '.bai',
  ].join(',')

  const S = {
    panel: {
      background: theme.panelBg, borderBottom: `1px solid ${theme.border}`,
      padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      position: 'relative',
    },
    group: { display: 'flex', alignItems: 'center', gap: 6 },
    label: { fontSize: 11, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' },
    fileInput: {
      background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4,
      color: theme.textPrimary, padding: '4px 6px', fontSize: 12, width: 280, cursor: 'pointer',
    },
    promptOverlay: {
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    promptBox: {
      background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
      borderRadius: 8, padding: '20px 24px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      maxWidth: 440, width: '90%',
    },
    promptTitle: { fontSize: 14, fontWeight: 700, color: theme.textPrimary, marginBottom: 8 },
    promptText: { fontSize: 12, color: theme.textSecondary, lineHeight: 1.6, marginBottom: 16 },
    promptFile: { fontWeight: 600, color: theme.textPrimary },
    promptBtns: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
    promptBtn: {
      background: theme.btnBg, border: `1px solid ${theme.borderStrong}`, borderRadius: 4,
      color: theme.btnText, padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    promptBtnPrimary: {
      background: '#1976d2', border: 'none', borderRadius: 4,
      color: '#fff', padding: '5px 16px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
  }

  /** Set the status line (null hides it). With `ms` it is hidden after that
   *  long, or replaced by `next` ([text, ms]) when given. It replaces the
   *  previous line along with its timer, so an earlier line's timer never
   *  cuts a later one short. */
  function setStatus(text, ms, next) {
    if (statusTimer.current) { clearTimeout(statusTimer.current); statusTimer.current = null }
    setStatusLine(text)
    if (text && ms) {
      statusTimer.current = setTimeout(() => {
        statusTimer.current = null
        if (next) setStatus(next[0], next[1])
        else setStatusLine(null)
      }, ms)
    }
  }

  /** Upload `file` as the genome; true when it loaded. */
  async function loadGenomeFile(file) {
    setLoading(true); setErr(null); setProgress(null)
    setStatus(`Uploading genome: ${file.name}...`)
    try {
      const res = await genomeApi.load(file, (p) => {
        setProgress({ ...p, label: file.name })
        if (p.percent >= 100) setStatus(`Processing genome: ${file.name}...`)
      })
      setProgress(null)
      const info = res.data
      if (info.name) info.name = cleanName(info.name)
      setGenome(info)
      if (info.chromosomes?.length > 0) {
        const chr = info.chromosomes[0]
        navigateTo(chr.name, 0, Math.min(chr.length, 50000))
      }
      if (info.is_annotated) {
        addGenomeAnnotationTrack({
          id: 'genome_annotations', name: `${info.name} (annotations)`,
          track_type: 'genome_annotations', file_format: 'genbank',
          targetChromosomes: info.annotated_chromosomes || null,
          featureTypes: info.feature_types || [],
        })
      }
      setStatus(`Genome loaded: ${info.name}`, 3000)
      return true
    } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null); setProgress(null); return false }
    finally { setLoading(false) }
  }

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    if (statusTimer.current) clearTimeout(statusTimer.current)
  }, [])

  /** Show notices (lengthPairingNotice, movedTracksNotice; falsy ones are
   *  skipped) for PAIRING_NOTICE_MS. */
  function showNotice(...items) {
    const list = items.filter(Boolean)
    if (!list.length) return
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotices(list)
    noticeTimer.current = setTimeout(() => { noticeTimer.current = null; setNotices([]) }, PAIRING_NOTICE_MS)
  }

  function clearNotices() {
    if (noticeTimer.current) { clearTimeout(noticeTimer.current); noticeTimer.current = null }
    setNotices([])
  }

  // A merge started from a page drop: clear what a merge here clears.
  useEffect(() => {
    if (!mergeSignal) return
    clearNotices()
    setErr(null)
  }, [mergeSignal])

  // A merge answered (here or from a page drop) while tracks wait in the
  // compatibility dialog: judge them again against the merged genome. Those
  // that match it now are added, as a compatible load is; the others stay,
  // with the reason as it stands now.
  useEffect(() => {
    if (!pairingVersion || !trackMismatch) return
    const now = trackMismatch.tracks.map(withPairing)
    if (now.every((t, i) => t === trackMismatch.tracks[i])) return
    const ok = now.filter(t => !isTrackMismatch(t))
    for (const t of ok) commitTrack(t)
    const rest = now.filter(isTrackMismatch)
    setTrackMismatch(rest.length ? { tracks: rest } : null)
    if (ok.length) {
      showNotice(lengthPairingNotice(ok))
      setStatus(`Added ${ok.length} track${ok.length > 1 ? 's' : ''}: ${ok.length > 1 ? 'they match' : 'it matches'} the genome now.`, 4000)
    }
  }, [pairingVersion])

  async function addChromosomeFiles(files) {
    setLoading(true); setErr(null); setProgress(null)
    // A pairing notice still up from a track load, here or in the drop
    // toast, may no longer hold.
    clearNotices()
    onMergeStart?.()
    const errors = []
    // The loaded tracks and chromosomes before the merge, to tell what it changed.
    let before = mergeBaseline([], getTracks())
    const oldChroms = new Set((genome?.chromosomes || []).map(c => c.name))
    let pairings = null
    for (const file of files) {
      setStatus(`Adding chromosomes from ${file.name}...`)
      try {
        const res = await genomeApi.addChromosomes(file, (p) => {
          setProgress({ ...p, label: file.name })
        })
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        before = mergeBaseline(before, getTracks())
        setGenome(info)
        // Each track's targets and compatibility against the merged genome
        // (tracks appear on the added chromosomes they have data for), the
        // annotation track if the merged genome has annotations, and fresh data.
        applyMerge(info)
        if (info.tracks) pairings = info.tracks
      } catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    setLoading(false)
    const { lost, moved, paired } = pairingChanges(before, pairings, oldChroms)
    const warning = lostPairingWarning(lost)
    showNotice(movedTracksNotice(moved), lengthPairingNotice(paired))
    if (errors.length || warning) {
      setErr([...errors, ...(warning ? [warning] : [])].join('; '))
    }
    if (errors.length) setStatus(null)
    else setStatus(`Added chromosomes from ${files.length} file${files.length > 1 ? 's' : ''}.`, 3000)
  }

  async function loadTrackEntries(entries) {
    if (!entries.length) return
    setLoading(true); setErr(null); setError(null); setProgress(null)
    const compatible = []
    const incompatible = []
    const errors = []
    const hints = []
    for (let idx = 0; idx < entries.length; idx++) {
      const { file, indexFile } = entries[idx]
      setStatus(`Loading track ${idx + 1}/${entries.length}: ${file.name}...`)
      try {
        // With the pairing of a merge that answered first, if any.
        const info = withPairing(await uploadTrack(file, undefined, indexFile, (p) => {
          setProgress({ ...p, label: file.name })
          if (p.percent >= 100) setStatus(`Processing: ${file.name}...`)
        }))
        if (isTrackMismatch(info)) {
          incompatible.push(info)
        } else {
          commitTrack(info)
          compatible.push(info)
        }
        // Collect hints (e.g. "convert to BigWig")
        if (info.hint) hints.push(info.hint)
      } catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    setLoading(false); setProgress(null)
    showNotice(lengthPairingNotice(compatible))
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else if (compatible.length > 0 && incompatible.length === 0) {
      const msg = `Added ${compatible.length} track${compatible.length > 1 ? 's' : ''}.`
      if (hints.length) setStatus(msg, 2000, [hints.join(' '), 8000])
      else setStatus(msg, 3000)
    } else setStatus(null)          // the rest waits in the compatibility dialog
    if (incompatible.length > 0) setTrackMismatch(prev => ({ tracks: [...(prev?.tracks || []), ...incompatible] }))
  }

  async function processFiles(fileList) {
    const files = Array.from(fileList)
    if (!files.length) return

    const { genomeFiles, trackEntries, unpairedBams, largeFiles, unknownFiles } = classifyFiles(files)

    if (unknownFiles.length) {
      const orphanBai = unknownFiles.filter(f => f._indexOrphan)
      const otherUnknown = unknownFiles.filter(f => !f._indexOrphan)
      if (orphanBai.length) {
        setBamPrompt({ bamFile: null, indexFile: orphanBai[0], bamPath: '', indexPath: '', error: null })
        if (orphanBai.length > 1) {
          // We can only pair one index at a time — tell the user the rest were
          // not handled rather than silently dropping them.
          setErr(`Multiple .bai index files selected; pairing '${orphanBai[0].name}' first. ` +
            `Load the others with their BAMs separately: ${orphanBai.slice(1).map(f => f.name).join(', ')}`)
        }
      }
      if (otherUnknown.length) {
        setErr(`Unsupported: ${otherUnknown.map(f => f.name).join(', ')}`)
      }
    }

    // Large files — show path dialog with warning
    if (largeFiles.length > 0) {
      const f = largeFiles[0]
      const sizeMb = (f.size / (1024 * 1024)).toFixed(0)
      const isBam = f.name.toLowerCase().endsWith('.bam')
      setBamPrompt({
        bamFile: isBam ? f : null,
        indexFile: null,
        bamPath: isBam ? '' : '',
        indexPath: '',
        error: null,
        _largeFile: f,
        _largeWarning: `${f.name} is ${sizeMb} MB. Large files load much faster via file path — the server reads directly from disk without uploading.`,
      })
      if (largeFiles.length > 1) {
        setErr(`${largeFiles.length - 1} additional large file(s) skipped — load one at a time via path.`)
      }
    }

    // Unpaired BAM files (any size) — open pairing dialog
    if (unpairedBams.length > 0 && largeFiles.length === 0) {
      setBamPrompt({ bamFile: unpairedBams[0], indexFile: null, bamPath: '', indexPath: '', error: null })
    }

    // Case 1: No genome loaded — auto-load first genome file
    if (genomeFiles.length > 0 && !genome) {
      if (!(await loadGenomeFile(genomeFiles[0]))) {
        // Nothing else can be loaded without it, nor added to it: name the
        // files that were not, after the reason.
        const rest = [...genomeFiles.slice(1), ...trackEntries.map(t => t.file)]
        if (rest.length) setErr(e => `${e}; not loaded: ${rest.map(f => f.name).join(', ')}`)
        if (inputRef.current) inputRef.current.value = ''
        return
      }
      // Remaining genome files → prompt to add as chromosomes
      if (genomeFiles.length > 1) {
        if (trackEntries.length > 0) await loadTrackEntries(trackEntries)
        setPrompt({ files: genomeFiles.slice(1) })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
      if (trackEntries.length > 0) await loadTrackEntries(trackEntries)
    }
    // Case 2: Genome already loaded and new genome file(s) selected — prompt
    else if (genomeFiles.length > 0 && genome) {
      if (trackEntries.length > 0) await loadTrackEntries(trackEntries)
      setPrompt({ files: genomeFiles })
    }
    // Case 3: Only track files
    else if (trackEntries.length > 0) {
      if (!genome) {
        setErr('Load a genome file first (.fasta, .gb, .genbank)')
      } else {
        await loadTrackEntries(trackEntries)
      }
    }

    if (inputRef.current) inputRef.current.value = ''
  }

  async function loadFromPath(rawPath, indexPath) {
    const path = rawPath.trim()
    if (!path) return
    setErr(null)
    const lower = path.toLowerCase()

    // Detect file type from extension
    const isGenome = GENOME_EXTS.has(getFileExt(path))
    const isTrack = TRACK_EXTS.has(getFileExt(path)) || lower.endsWith('.bai')

    if (isGenome && !genome) {
      // Load as genome
      setLoading(true); setStatus(`Loading genome from path...`)
      try {
        const res = await genomeApi.loadPath(path)
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        setGenome(info)
        if (info.chromosomes?.length > 0) {
          const chr = info.chromosomes[0]
          navigateTo(chr.name, 0, Math.min(chr.length, 50000))
        }
        if (info.is_annotated) {
          addGenomeAnnotationTrack({
            id: 'genome_annotations', name: `${info.name} (annotations)`,
            track_type: 'genome_annotations', file_format: 'genbank',
            targetChromosomes: info.annotated_chromosomes || null,
            featureTypes: info.feature_types || [],
          })
        }
        setStatus(`Genome loaded: ${info.name}`, 3000)
      } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null) }
      finally { setLoading(false) }
    } else if (isTrack || isGenome) {
      // Load as track
      if (!genome) { setErr('Load a genome file first'); return }
      setLoading(true); setStatus(`Loading track from path...`)
      try {
        const name = path.split(/[/\\]/).pop() || path
        const res = await tracksApi.loadPath(path, name, indexPath && indexPath.trim())
        const info = withPairing(res.data)     // with a merge's pairing that answered first
        if (info.name) info.name = cleanName(info.name)
        if (isTrackMismatch(info)) {
          // The same check as uploads: ask before adding a track that may
          // not belong to this genome (Load Anyway / Skip).
          setTrackMismatch(prev => ({ tracks: [...(prev?.tracks || []), info] }))
          setStatus(null)
        } else {
          commitTrack(info)
          showNotice(lengthPairingNotice([info]))
          if (info.hint) setStatus(`Track loaded: ${info.name}`, 2000, [info.hint, 8000])
          else setStatus(`Track loaded: ${info.name}`, 3000)
        }
      } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null) }
      finally { setLoading(false) }
    } else {
      setErr(`Unsupported file type: ${path.split(/[/\\]/).pop()}`)
    }
    setPathText('')
  }

  function onPathSubmit(e) {
    e.preventDefault()
    loadFromPath(pathText)
  }

  function onFilesSelected(e) {
    const files = e.target.files
    if (!files?.length) return
    setErr(null)
    processFiles(files)
  }

  async function handlePromptChromosome() {
    if (!prompt) return
    const { files } = prompt
    setPrompt(null)
    await addChromosomeFiles(files)
  }

  async function handlePromptTrack() {
    if (!prompt) return
    const { files } = prompt
    setPrompt(null)
    // Wrap plain genome files as trackEntries (no index)
    await loadTrackEntries(files.map(f => ({ file: f, indexFile: null })))
  }

  function handlePromptSkip() {
    setPrompt(null)
  }

  // ── BAM pairing dialog handlers ────────────────────────────────
  function bamPromptPickBam() { bamPickerRef.current?.click() }
  function bamPromptPickBai() { baiPickerRef.current?.click() }

  function bamPromptOnBamFile(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.bam')) {
      setBamPrompt(p => ({ ...p, error: 'Please select a .bam file' }))
      return
    }
    setBamPrompt(p => ({ ...p, bamFile: f, bamPath: '', error: null }))
  }

  function bamPromptOnBaiFile(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.bai')) {
      setBamPrompt(p => ({ ...p, error: 'Please select a .bai index file' }))
      return
    }
    setBamPrompt(p => ({ ...p, indexFile: f, indexPath: '', error: null }))
  }

  function bamPromptHasBam(p) {
    return p && (p.bamFile || p.bamPath.trim())
  }
  function bamPromptHasBai(p) {
    return p && (p.indexFile || p.indexPath.trim())
  }
  function bamPromptReady(p) {
    return bamPromptHasBam(p) && bamPromptHasBai(p)
  }

  async function bamPromptLoad() {
    if (!bamPrompt) return
    const { bamFile, indexFile, bamPath, indexPath, _largeFile } = bamPrompt
    const hasBamPath = bamPath.trim()
    const hasBaiPath = indexPath.trim()
    const isLargeNonBam = _largeFile && !_largeFile.name.toLowerCase().endsWith('.bam')

    // For non-BAM large files, only need the path
    if (isLargeNonBam) {
      if (!hasBamPath) {
        setBamPrompt(p => ({ ...p, error: 'File path is required' }))
        return
      }
      setBamPrompt(null)
      await loadFromPath(hasBamPath)
      return
    }

    // BAM flow
    if (!bamFile && !hasBamPath) {
      setBamPrompt(p => ({ ...p, error: 'BAM file or path is required' }))
      return
    }
    if (!indexFile && !hasBaiPath) {
      setBamPrompt(p => ({ ...p, error: 'BAM index (.bai) file or path is required' }))
      return
    }

    if (hasBamPath && !hasBamPath.toLowerCase().endsWith('.bam')) {
      setBamPrompt(p => ({ ...p, error: 'BAM path must end with .bam' }))
      return
    }
    if (hasBaiPath && !hasBaiPath.toLowerCase().endsWith('.bai')) {
      setBamPrompt(p => ({ ...p, error: 'Index path must end with .bai' }))
      return
    }

    setBamPrompt(null)

    if (!bamFile && hasBamPath) {
      // Pass the index path through so a .bai in a different folder (or with a
      // non-standard name) is honored instead of silently dropped.
      await loadFromPath(hasBamPath, hasBaiPath)
      return
    }

    await loadTrackEntries([{ file: bamFile, indexFile: indexFile }])
  }

  function bamPromptCancel() { setBamPrompt(null) }

  async function handleMismatchSkip() {
    if (!trackMismatch) return
    for (const t of trackMismatch.tracks) await discardTrack(t.id)
    setTrackMismatch(null)
  }

  function handleMismatchLoad() {
    if (!trackMismatch) return
    for (const t of trackMismatch.tracks) commitTrack(t)
    setTrackMismatch(null)
    showNotice(lengthPairingNotice(trackMismatch.tracks))
    setStatus(`Added ${trackMismatch.tracks.length} track${trackMismatch.tracks.length > 1 ? 's' : ''}.`, 3000)
  }

  const fileNames = prompt ? prompt.files.map(f => f.name).join(', ') : ''
  const plural = prompt && prompt.files.length > 1
  // A GenBank file can be loaded as a track of its annotations; a FASTA file can't.
  const promptTrackable = prompt && prompt.files.some(f => GENBANK_EXTS.has(getFileExt(f.name)))

  return (
    <div style={S.panel} data-tour="file-loader">
      <div style={S.group} title="Select genome or track files">
        <span style={S.label}>Load Files</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={S.fileInput}
          disabled={loading}
          accept={ALL_ACCEPT}
          onChange={onFilesSelected}
        />
      </div>

      <button
        style={{ ...S.group, background: 'none', border: `1px solid ${theme.borderAccent}`, borderRadius: 4,
          padding: '3px 8px', cursor: 'pointer', color: theme.textSecondary, fontSize: 11 }}
        onClick={() => setShowPathInput(p => !p)}
        title="Load file by local path (recommended for large BAM files)"
      >
        {showPathInput ? '\u2715' : '\u{1F4C2}'} Path
      </button>

      {showPathInput && (
        <form onSubmit={onPathSubmit} style={{ display: 'flex', gap: 4 }}>
          <input
            type="text"
            value={pathText}
            onChange={e => setPathText(e.target.value)}
            placeholder="/path/to/file.bam"
            disabled={loading}
            style={{
              background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4,
              color: theme.textPrimary, padding: '4px 8px', fontSize: 11, width: 260,
              fontFamily: 'monospace',
            }}
          />
          <button
            type="submit"
            disabled={loading || !pathText.trim()}
            style={{ background: theme.btnBg, border: 'none', borderRadius: 4,
              color: theme.btnText, padding: '4px 10px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
          >Load</button>
        </form>
      )}

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: theme.textMuted, fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {status || 'Loading\u2026'}
          </span>
          {progress && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 100 }}>
              <div style={{
                flex: 1, height: 6, background: theme.inputBg,
                borderRadius: 3, overflow: 'hidden', minWidth: 60,
              }}>
                <div style={{
                  width: `${progress.percent}%`, height: '100%',
                  background: progress.percent >= 100 ? '#66bb6a' : '#42a5f5',
                  borderRadius: 3, transition: 'width 0.2s ease',
                }} />
              </div>
              <span style={{ fontSize: 10, color: theme.textTertiary, whiteSpace: 'nowrap' }}>
                {progress.percent < 100
                  ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                  : 'Processing...'}
              </span>
            </div>
          )}
        </div>
      ) : (
        <span style={{ fontSize: 10, color: theme.textMuted, fontStyle: 'italic' }}>
          or drag & drop anywhere
        </span>
      )}

      {!loading && status && <span style={{ color: '#81c784', fontSize: 11 }}>{status}</span>}
      {notices.map((n, i) => <span key={i} style={{ color: '#ffb74d', fontSize: 11 }} title={n.title}>{n.text}</span>)}
      {(err || trackError) && <span style={{ color: '#ef9a9a', fontSize: 11 }}>{err || trackError}</span>}

      {/* Prompt dialog for genome files when genome already loaded */}
      {prompt && (
        <div style={S.promptOverlay}>
          <div style={S.promptBox} onClick={e => e.stopPropagation()}>
            <div style={S.promptTitle}>Genome file{plural ? 's' : ''} detected</div>
            <div style={S.promptText}>
              <span style={S.promptFile}>{fileNames}</span>
              {plural
                ? ' appear to be genome files. A genome is already loaded.'
                : ' appears to be a genome file. A genome is already loaded.'}
              <br />How would you like to handle {plural ? 'them' : 'it'}?
            </div>
            <div style={S.promptBtns}>
              <button style={S.promptBtn} onClick={handlePromptSkip}>Skip</button>
              {promptTrackable && (
                <button style={S.promptBtn} onClick={handlePromptTrack}>
                  Add as Track{plural ? 's' : ''}
                </button>
              )}
              <button style={S.promptBtnPrimary} onClick={handlePromptChromosome}>
                Add as Chromosome{plural ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt dialog for track-genome compatibility mismatch */}
      {trackMismatch && (
        <div style={S.promptOverlay}>
          <div style={S.promptBox} onClick={e => e.stopPropagation()}>
            <div style={S.promptTitle}>Track compatibility warning</div>
            <div style={S.promptText}>
              {trackMismatch.tracks.map(t => (
                <div key={t.id} style={{ marginBottom: 6 }}>
                  <span style={S.promptFile}>{t.name}</span>
                  {' \u2014 '}{t.compatibility?.message || 'Possible mismatch with loaded genome'}
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                {trackMismatch.tracks.length > 1
                  ? 'These tracks may not match the loaded genome.'
                  : 'This track may not match the loaded genome.'}
              </div>
            </div>
            <div style={S.promptBtns}>
              <button style={S.promptBtn} onClick={handleMismatchSkip}>Skip</button>
              <button style={S.promptBtnPrimary} onClick={handleMismatchLoad}>Load Anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* BAM + BAI pairing / large file dialog */}
      {bamPrompt && (() => {
        const isLargeNonBam = bamPrompt._largeFile && !bamPrompt._largeFile.name.toLowerCase().endsWith('.bam')
        const ready = isLargeNonBam ? !!bamPrompt.bamPath.trim() : bamPromptReady(bamPrompt)
        const bamSizeMb = bamPrompt.bamFile ? bamPrompt.bamFile.size / (1024 * 1024) : 0
        const isLargeUpload = bamPrompt.bamFile && bamSizeMb > 50
        const bamOk = bamPromptHasBam(bamPrompt)
        const baiOk = bamPromptHasBai(bamPrompt)
        const pathInputStyle = {
          flex: 1, padding: '5px 8px', borderRadius: 4, fontSize: 11,
          background: theme.inputBg, color: theme.textPrimary,
          fontFamily: 'monospace',
        }
        const dialogTitle = isLargeNonBam
          ? `Load ${bamPrompt._largeFile.name.split('.').pop().toUpperCase()} Track`
          : 'Load BAM Track'
        const dialogDesc = isLargeNonBam
          ? 'Paste the local file path for the server to read directly from disk.'
          : 'BAM files require a matching .bai index. Browse for files or paste local paths.'
        return (
        <div style={S.promptOverlay} onClick={bamPromptCancel}>
          <div style={{ ...S.promptBox, maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div style={S.promptTitle}>{dialogTitle}</div>
            <div style={{ ...S.promptText, marginBottom: 12 }}>
              {dialogDesc}
            </div>

            {/* File path slot */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4, fontWeight: 600 }}>
                {isLargeNonBam ? 'File path' : '.bam file'} {bamOk && <span style={{ color: '#66bb6a' }}>{'\u2713'}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  value={bamPrompt.bamFile ? bamPrompt.bamFile.name : bamPrompt.bamPath}
                  onChange={e => setBamPrompt(p => ({ ...p, bamPath: e.target.value, bamFile: null, error: null }))}
                  placeholder={isLargeNonBam ? '/path/to/file' : '/path/to/reads.bam'}
                  style={{ ...pathInputStyle, border: `1px solid ${bamOk ? '#66bb6a' : theme.borderAccent}` }}
                />
                {!isLargeNonBam && (
                  <button style={{ ...S.promptBtn, padding: '4px 12px', whiteSpace: 'nowrap' }} onClick={bamPromptPickBam}>Browse</button>
                )}
              </div>
            </div>

            {/* BAI slot — only for BAM files */}
            {!isLargeNonBam && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4, fontWeight: 600 }}>
                  .bai index {baiOk && <span style={{ color: '#66bb6a' }}>{'\u2713'}</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={bamPrompt.indexFile ? bamPrompt.indexFile.name : bamPrompt.indexPath}
                    onChange={e => setBamPrompt(p => ({ ...p, indexPath: e.target.value, indexFile: null, error: null }))}
                    placeholder="/path/to/reads.bam.bai"
                    style={{ ...pathInputStyle, border: `1px solid ${baiOk ? '#66bb6a' : theme.borderAccent}` }}
                  />
                  <button style={{ ...S.promptBtn, padding: '4px 12px', whiteSpace: 'nowrap' }} onClick={bamPromptPickBai}>Browse</button>
                </div>
              </div>
            )}

            {/* Hidden file inputs */}
            <input ref={bamPickerRef} type="file" accept=".bam" style={{ display: 'none' }} onChange={bamPromptOnBamFile} />
            <input ref={baiPickerRef} type="file" accept=".bai,.bam.bai" style={{ display: 'none' }} onChange={bamPromptOnBaiFile} />

            {/* Large file warning */}
            {(isLargeUpload || bamPrompt._largeWarning) && (
              <div style={{ fontSize: 11, color: '#ffb74d', marginBottom: 8, padding: '6px 10px',
                background: 'rgba(255,183,77,0.1)', borderRadius: 4, border: '1px solid rgba(255,183,77,0.3)' }}>
                {bamPrompt._largeWarning || (
                  <><strong>Large file ({bamSizeMb.toFixed(0)} MB)</strong> — uploading may be slow.
                  Paste the file path instead for instant loading.</>
                )}
              </div>
            )}

            {/* Error message */}
            {bamPrompt.error && (
              <div style={{ fontSize: 11, color: '#ef9a9a', marginBottom: 8, padding: '4px 0' }}>
                {bamPrompt.error}
              </div>
            )}

            {/* Path hint */}
            {!isLargeUpload && (
              <div style={{ fontSize: 10, color: theme.textTertiary, marginBottom: 10 }}>
                Tip: Paste a local file path to skip uploading — the server reads directly from disk.
                The .bai is auto-discovered if next to the .bam.
              </div>
            )}

            <div style={S.promptBtns}>
              <button style={S.promptBtn} onClick={bamPromptCancel}>Cancel</button>
              <button
                style={{
                  ...S.promptBtnPrimary,
                  opacity: ready ? 1 : 0.4,
                  cursor: ready ? 'pointer' : 'default',
                }}
                disabled={!ready}
                onClick={bamPromptLoad}
              >
                Open
              </button>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
