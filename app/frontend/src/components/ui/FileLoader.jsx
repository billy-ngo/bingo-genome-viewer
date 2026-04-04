/**
 * FileLoader.jsx — Unified file upload panel.
 *
 * A single file picker accepts all supported file types. Files are
 * automatically classified as genome or track by extension. If a genome
 * file is selected when one is already loaded, the user is prompted to
 * add it as a new chromosome, load it as a track, or skip it.
 */
import React, { useState, useRef } from 'react'
import { genomeApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'

function isTrackMismatch(info) {
  const c = info?.compatibility
  return c && c.status !== 'ok' && c.status !== 'no_genome'
}
import { useTheme } from '../../store/ThemeContext'

const GENOME_EXTS = new Set(['.gb', '.gbk', '.genbank', '.fasta', '.fa'])
const TRACK_EXTS = new Set(['.bam', '.bw', '.bigwig', '.wig', '.bedgraph', '.bdg', '.vcf', '.bed', '.gtf', '.gff', '.gff2', '.gff3'])

function getFileExt(name) {
  if (!name) return ''
  if (name.toLowerCase().endsWith('.vcf.gz')) return '.vcf.gz'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export default function FileLoader() {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const { addTrack, uploadTrack, commitTrack, discardTrack, addGenomeAnnotationTrack, error: trackError, setError } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
  const [prompt, setPrompt] = useState(null) // { files: File[] }
  const [trackMismatch, setTrackMismatch] = useState(null) // { tracks: [...] }
  const inputRef = useRef(null)

  const ALL_ACCEPT = [
    ...Array.from(GENOME_EXTS),
    ...Array.from(TRACK_EXTS),
    '.vcf.gz',
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
    setLoading(true); setErr(null); setStatus(`Loading genome: ${file.name}...`)
    try {
      const res = await genomeApi.load(file)
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
        })
      }
      setStatus(`Genome loaded: ${info.name}`)
      setTimeout(() => setStatus(null), 3000)
    } catch (e) { setErr(e.response?.data?.detail || e.message); setStatus(null) }
    finally { setLoading(false) }
  }

  async function addChromosomeFiles(files) {
    setLoading(true); setErr(null)
    const errors = []
    for (const file of files) {
      setStatus(`Adding chromosomes from ${file.name}...`)
      try {
        const res = await genomeApi.addChromosomes(file)
        const info = res.data
        if (info.name) info.name = cleanName(info.name)
        setGenome(info)
        // Ensure annotation track exists when the merged genome has annotations
        if (info.is_annotated) {
          addGenomeAnnotationTrack({
            id: 'genome_annotations', name: `${info.name} (annotations)`,
            track_type: 'genome_annotations', file_format: 'genbank',
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

  async function loadTrackFiles(files) {
    if (!files.length) return
    setLoading(true); setErr(null); setError(null)
    setStatus(`Loading ${files.length} track${files.length > 1 ? 's' : ''}...`)
    const compatible = []
    const incompatible = []
    const errors = []
    for (const file of files) {
      try {
        const info = await uploadTrack(file, undefined)
        if (isTrackMismatch(info)) {
          incompatible.push(info)
        } else {
          commitTrack(info)
          compatible.push(info)
        }
      } catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    setLoading(false)
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else if (compatible.length > 0 && incompatible.length === 0) {
      setStatus(`Added ${compatible.length} track${compatible.length > 1 ? 's' : ''}.`)
      setTimeout(() => setStatus(null), 3000)
    } else if (incompatible.length === 0) { setStatus(null) }
    if (incompatible.length > 0) setTrackMismatch({ tracks: incompatible })
  }

  async function processFiles(fileList) {
    const files = Array.from(fileList)
    if (!files.length) return

    const genomeFiles = []
    const trackFiles = []
    const unknownFiles = []

    for (const f of files) {
      const ext = getFileExt(f.name)
      if (GENOME_EXTS.has(ext)) genomeFiles.push(f)
      else if (TRACK_EXTS.has(ext) || ext === '.vcf.gz') trackFiles.push(f)
      else unknownFiles.push(f)
    }

    if (unknownFiles.length) {
      setErr(`Unsupported: ${unknownFiles.map(f => f.name).join(', ')}`)
    }

    // Case 1: No genome loaded — auto-load first genome file
    if (genomeFiles.length > 0 && !genome) {
      await loadGenomeFile(genomeFiles[0])
      // Remaining genome files → prompt to add as chromosomes
      if (genomeFiles.length > 1) {
        if (trackFiles.length > 0) await loadTrackFiles(trackFiles)
        setPrompt({ files: genomeFiles.slice(1) })
        if (inputRef.current) inputRef.current.value = ''
        return
      }
      if (trackFiles.length > 0) await loadTrackFiles(trackFiles)
    }
    // Case 2: Genome already loaded and new genome file(s) selected — prompt
    else if (genomeFiles.length > 0 && genome) {
      if (trackFiles.length > 0) await loadTrackFiles(trackFiles)
      setPrompt({ files: genomeFiles })
    }
    // Case 3: Only track files
    else if (trackFiles.length > 0) {
      if (!genome) {
        setErr('Load a genome file first (.fasta, .gb, .genbank)')
      } else {
        await loadTrackFiles(trackFiles)
      }
    }

    if (inputRef.current) inputRef.current.value = ''
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
    await loadTrackFiles(files)
  }

  function handlePromptSkip() {
    setPrompt(null)
  }

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

      <span style={{ fontSize: 10, color: theme.textMuted, fontStyle: 'italic' }}>
        {loading ? status || 'Loading\u2026' : 'or drag & drop anywhere'}
      </span>

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
    </div>
  )
}
