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
 */
import React, { useState, useRef } from 'react'
import { genomeApi, tracksApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'

function isTrackMismatch(info) {
  const c = info?.compatibility
  return c && c.status !== 'ok' && c.status !== 'no_genome'
}
import { useTheme } from '../../store/ThemeContext'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const GENOME_EXTS = new Set(['.gb', '.gbk', '.genbank', '.fasta', '.fa'])
const TRACK_EXTS = new Set(['.bam', '.bw', '.bigwig', '.wig', '.bedgraph', '.bdg', '.vcf', '.bed', '.gtf', '.gff', '.gff2', '.gff3'])
const INDEX_EXTS = new Set(['.bai'])

function getFileExt(name) {
  if (!name) return ''
  const lower = name.toLowerCase()
  if (lower.endsWith('.vcf.gz')) return '.vcf.gz'
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

  for (const f of files) {
    const ext = getFileExt(f.name)
    if (GENOME_EXTS.has(ext)) {
      genomeFiles.push(f)
    } else if (ext === '.bam') {
      bamFiles.push(f)
    } else if (isIndexFile(f.name)) {
      indexFiles.push(f)
    } else if (TRACK_EXTS.has(ext) || ext === '.vcf.gz') {
      otherTrackFiles.push(f)
    } else {
      unknownFiles.push(f)
    }
  }

  // Pair BAM files with their index files by name
  const trackEntries = []
  const unpairedBams = []
  for (const bam of bamFiles) {
    const baseName = bam.name.replace(/\.bam$/i, '')
    const paired = indexFiles.find(idx => {
      const idxName = idx.name.toLowerCase()
      return idxName === bam.name.toLowerCase() + '.bai' || idxName === baseName.toLowerCase() + '.bai'
    })
    if (paired) {
      trackEntries.push({ file: bam, indexFile: paired })
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

  return { genomeFiles, trackEntries, unpairedBams, unknownFiles }
}

export default function FileLoader() {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const { addTrack, uploadTrack, commitTrack, discardTrack, addGenomeAnnotationTrack, error: trackError, setError } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
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
    '.vcf.gz',
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
        })
      }
      setStatus(`Genome loaded: ${info.name}`)
      setTimeout(() => setStatus(null), 3000)
    } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null); setProgress(null) }
    finally { setLoading(false) }
  }

  async function addChromosomeFiles(files) {
    setLoading(true); setErr(null); setProgress(null)
    const errors = []
    for (const file of files) {
      setStatus(`Adding chromosomes from ${file.name}...`)
      try {
        const res = await genomeApi.addChromosomes(file, (p) => {
          setProgress({ ...p, label: file.name })
        })
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        setGenome(info)
        // Ensure annotation track exists when the merged genome has annotations
        if (info.is_annotated) {
          addGenomeAnnotationTrack({
            id: 'genome_annotations', name: `${info.name} (annotations)`,
            track_type: 'genome_annotations', file_format: 'genbank',
            targetChromosomes: info.annotated_chromosomes || null,
          })
        }
      } catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    setLoading(false)
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else {
      setStatus(`Added chromosomes from ${files.length} file${files.length > 1 ? 's' : ''}.`)
      setTimeout(() => setStatus(null), 3000)
    }
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
        const info = await uploadTrack(file, undefined, indexFile, (p) => {
          setProgress({ ...p, label: file.name })
          if (p.percent >= 100) setStatus(`Processing: ${file.name}...`)
        })
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
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else if (compatible.length > 0 && incompatible.length === 0) {
      const msg = `Added ${compatible.length} track${compatible.length > 1 ? 's' : ''}.`
      if (hints.length) {
        setStatus(msg)
        setTimeout(() => { setStatus(hints.join(' ')); setTimeout(() => setStatus(null), 8000) }, 2000)
      } else {
        setStatus(msg)
        setTimeout(() => setStatus(null), 3000)
      }
    } else if (incompatible.length === 0) { setStatus(null) }
    if (incompatible.length > 0) setTrackMismatch({ tracks: incompatible })
  }

  async function processFiles(fileList) {
    const files = Array.from(fileList)
    if (!files.length) return

    const { genomeFiles, trackEntries, unpairedBams, unknownFiles } = classifyFiles(files)

    if (unknownFiles.length) {
      const orphanBai = unknownFiles.filter(f => f._indexOrphan)
      const otherUnknown = unknownFiles.filter(f => !f._indexOrphan)
      if (orphanBai.length) {
        // Lone .bai without .bam — open BAM pairing dialog
        setBamPrompt({ bamFile: null, indexFile: orphanBai[0], bamPath: '', indexPath: '', error: null })
      }
      if (otherUnknown.length) {
        setErr(`Unsupported: ${otherUnknown.map(f => f.name).join(', ')}`)
      }
    }

    // Unpaired BAM files — open pairing dialog
    if (unpairedBams.length > 0) {
      setBamPrompt({ bamFile: unpairedBams[0], indexFile: null, bamPath: '', indexPath: '', error: null })
    }

    // Case 1: No genome loaded — auto-load first genome file
    if (genomeFiles.length > 0 && !genome) {
      await loadGenomeFile(genomeFiles[0])
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

  async function loadFromPath(rawPath) {
    const path = rawPath.trim()
    if (!path) return
    setErr(null)
    const lower = path.toLowerCase()

    // Detect file type from extension
    const isGenome = GENOME_EXTS.has(getFileExt(path))
    const isTrack = TRACK_EXTS.has(getFileExt(path)) || lower.endsWith('.vcf.gz') || lower.endsWith('.bai')

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
          })
        }
        setStatus(`Genome loaded: ${info.name}`)
        setTimeout(() => setStatus(null), 3000)
      } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null) }
      finally { setLoading(false) }
    } else if (isTrack || isGenome) {
      // Load as track
      if (!genome) { setErr('Load a genome file first'); return }
      setLoading(true); setStatus(`Loading track from path...`)
      try {
        const name = path.split(/[/\\]/).pop() || path
        const res = await tracksApi.loadPath(path, name)
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        commitTrack(info)
        setStatus(`Track loaded: ${info.name}`)
        if (info.hint) {
          setTimeout(() => { setStatus(info.hint); setTimeout(() => setStatus(null), 8000) }, 2000)
        } else {
          setTimeout(() => setStatus(null), 3000)
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
    const { bamFile, indexFile, bamPath, indexPath } = bamPrompt
    const hasBamPath = bamPath.trim()
    const hasBaiPath = indexPath.trim()

    if (!bamFile && !hasBamPath) {
      setBamPrompt(p => ({ ...p, error: 'BAM file or path is required' }))
      return
    }
    if (!indexFile && !hasBaiPath) {
      setBamPrompt(p => ({ ...p, error: 'BAM index (.bai) file or path is required' }))
      return
    }

    // Validate path extensions
    if (hasBamPath && !hasBamPath.toLowerCase().endsWith('.bam')) {
      setBamPrompt(p => ({ ...p, error: 'BAM path must end with .bam' }))
      return
    }
    if (hasBaiPath && !hasBaiPath.toLowerCase().endsWith('.bai')) {
      setBamPrompt(p => ({ ...p, error: 'Index path must end with .bai' }))
      return
    }

    setBamPrompt(null)

    // If both are paths, load via path endpoint (server reads directly)
    if (!bamFile && hasBamPath) {
      await loadFromPath(hasBamPath)
      return
    }

    // Upload files
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
    setStatus(`Added ${trackMismatch.tracks.length} track${trackMismatch.tracks.length > 1 ? 's' : ''}.`)
    setTimeout(() => setStatus(null), 3000)
  }

  const fileNames = prompt ? prompt.files.map(f => f.name).join(', ') : ''
  const plural = prompt && prompt.files.length > 1

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
              <button style={S.promptBtn} onClick={handlePromptTrack}>
                Add as Track{plural ? 's' : ''}
              </button>
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

      {/* BAM + BAI pairing dialog */}
      {bamPrompt && (() => {
        const ready = bamPromptReady(bamPrompt)
        const bamSizeMb = bamPrompt.bamFile ? bamPrompt.bamFile.size / (1024 * 1024) : 0
        const isLargeUpload = bamPrompt.bamFile && bamSizeMb > 50
        const bamOk = bamPromptHasBam(bamPrompt)
        const baiOk = bamPromptHasBai(bamPrompt)
        const pathInputStyle = {
          flex: 1, padding: '5px 8px', borderRadius: 4, fontSize: 11,
          background: theme.inputBg, color: theme.textPrimary,
          fontFamily: 'monospace',
        }
        return (
        <div style={S.promptOverlay} onClick={bamPromptCancel}>
          <div style={{ ...S.promptBox, maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div style={S.promptTitle}>Load BAM Track</div>
            <div style={{ ...S.promptText, marginBottom: 12 }}>
              BAM files require a matching <strong>.bai</strong> index. Browse for files or paste local paths.
            </div>

            {/* BAM slot */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 4, fontWeight: 600 }}>
                .bam file {bamOk && <span style={{ color: '#66bb6a' }}>{'\u2713'}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  value={bamPrompt.bamFile ? bamPrompt.bamFile.name : bamPrompt.bamPath}
                  onChange={e => setBamPrompt(p => ({ ...p, bamPath: e.target.value, bamFile: null, error: null }))}
                  placeholder="/path/to/reads.bam"
                  style={{ ...pathInputStyle, border: `1px solid ${bamOk ? '#66bb6a' : theme.borderAccent}` }}
                />
                <button style={{ ...S.promptBtn, padding: '4px 12px', whiteSpace: 'nowrap' }} onClick={bamPromptPickBam}>Browse</button>
              </div>
            </div>

            {/* BAI slot */}
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

            {/* Hidden file inputs */}
            <input ref={bamPickerRef} type="file" accept=".bam" style={{ display: 'none' }} onChange={bamPromptOnBamFile} />
            <input ref={baiPickerRef} type="file" accept=".bai,.bam.bai" style={{ display: 'none' }} onChange={bamPromptOnBaiFile} />

            {/* Large file warning — only when a file (not path) is selected */}
            {isLargeUpload && (
              <div style={{ fontSize: 11, color: '#ffb74d', marginBottom: 8, padding: '6px 10px',
                background: 'rgba(255,183,77,0.1)', borderRadius: 4, border: '1px solid rgba(255,183,77,0.3)' }}>
                <strong>Large file ({bamSizeMb.toFixed(0)} MB)</strong> — uploading may be slow.
                Paste the file path instead for instant loading (the server reads directly from disk).
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
