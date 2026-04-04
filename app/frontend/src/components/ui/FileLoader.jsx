/**
 * FileLoader.jsx — File upload panel with auto-load and drag-and-drop.
 *
 * Accepts genome files (FASTA, GenBank) and track files (BAM, BigWig, WIG,
 * VCF, BED, GTF, GFF). Files load automatically when selected or dropped.
 */
import React, { useState, useRef, useCallback } from 'react'
import { genomeApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

const GENOME_EXTS = new Set(['.gb', '.gbk', '.genbank', '.fasta', '.fa'])
const TRACK_EXTS = new Set([
  '.bam', '.bw', '.bigwig', '.wig', '.bedgraph', '.bdg',
  '.vcf', '.bed', '.gtf', '.gff', '.gff2', '.gff3',
])

function getExt(name) {
  if (!name) return ''
  if (name.toLowerCase().endsWith('.vcf.gz')) return '.vcf.gz'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function classifyFile(file) {
  const ext = getExt(file.name)
  if (GENOME_EXTS.has(ext)) return 'genome'
  if (TRACK_EXTS.has(ext) || ext === '.vcf.gz') return 'track'
  return 'unknown'
}

export default function FileLoader() {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const { addTrack, addGenomeAnnotationTrack, error: trackError, setError } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const genomeInputRef = useRef(null)
  const trackInputRef = useRef(null)
  const dragCounter = useRef(0)

  const S = {
    panel: {
      background: theme.panelBg, borderBottom: `1px solid ${theme.border}`,
      padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      position: 'relative', transition: 'background 0.15s',
      ...(dragOver ? { background: theme.btnBg } : {}),
    },
    group: { display: 'flex', alignItems: 'center', gap: 6 },
    label: { fontSize: 11, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' },
    fileInput: {
      background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4,
      color: theme.textPrimary, padding: '4px 6px', fontSize: 12, width: 220, cursor: 'pointer',
    },
    dropOverlay: {
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(25,118,210,0.12)', border: `2px dashed ${theme.textSecondary}`,
      borderRadius: 4, zIndex: 5, pointerEvents: 'none',
    },
    dropText: { fontSize: 13, fontWeight: 600, color: theme.textPrimary },
  }

  async function loadGenomeFile(file) {
    setLoading(true); setErr(null); setStatus(`Loading genome: ${file.name}...`)
    try {
      const res = await genomeApi.load(file)
      const info = res.data
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

  async function loadTrackFiles(files) {
    setLoading(true); setErr(null); setError(null)
    setStatus(`Loading ${files.length} track${files.length > 1 ? 's' : ''}...`)
    const errors = []
    for (const file of files) {
      try { await addTrack(file, undefined) }
      catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    setLoading(false)
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else { setStatus(`Added ${files.length} track${files.length > 1 ? 's' : ''}.`); setTimeout(() => setStatus(null), 3000) }
  }

  function onGenomeSelected(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(null)
    loadGenomeFile(file)
  }

  function onTracksSelected(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setErr(null)
    loadTrackFiles(files).then(() => {
      if (trackInputRef.current) trackInputRef.current.value = ''
    })
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)

    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return

    const genomeFiles = []
    const trackFiles = []
    const unknownFiles = []

    for (const f of files) {
      const type = classifyFile(f)
      if (type === 'genome') genomeFiles.push(f)
      else if (type === 'track') trackFiles.push(f)
      else unknownFiles.push(f)
    }

    if (unknownFiles.length && !genomeFiles.length && !trackFiles.length) {
      setErr(`Unsupported file${unknownFiles.length > 1 ? 's' : ''}: ${unknownFiles.map(f => f.name).join(', ')}`)
      return
    }

    ;(async () => {
      if (genomeFiles.length > 0 && !genome) {
        await loadGenomeFile(genomeFiles[0])
        if (genomeFiles.length > 1) trackFiles.push(...genomeFiles.slice(1))
      } else if (genomeFiles.length > 0 && genome) {
        trackFiles.push(...genomeFiles)
      }

      if (trackFiles.length > 0) await loadTrackFiles(trackFiles)

      if (unknownFiles.length) {
        setErr(prev => {
          const msg = `Skipped unsupported: ${unknownFiles.map(f => f.name).join(', ')}`
          return prev ? `${prev} | ${msg}` : msg
        })
      }
    })()
  }, [genome])

  const onDragEnter = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    dragCounter.current++
    if (dragCounter.current === 1) setDragOver(true)
  }, [])

  const onDragLeave = useCallback((e) => {
    e.preventDefault(); e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false) }
  }, [])

  const onDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation() }, [])

  return (
    <div
      style={S.panel}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div style={S.dropOverlay}>
          <span style={S.dropText}>Drop genome or track files here</span>
        </div>
      )}

      <div style={S.group} title="Select a reference genome file (.gb, .gbk, .fasta, .fa)">
        <span style={S.label}>Genome</span>
        <input ref={genomeInputRef} type="file" style={S.fileInput} disabled={loading}
          accept=".gb,.gbk,.genbank,.fasta,.fa"
          onChange={onGenomeSelected} />
      </div>
      {genome && (
        <div style={S.group} title="Select one or more track files (.bam, .bw, .wig, .vcf, .bed, .gff, .gtf)">
          <span style={S.label}>Tracks</span>
          <input ref={trackInputRef} type="file" multiple style={S.fileInput} disabled={loading}
            accept=".bam,.bw,.bigwig,.wig,.bedgraph,.bdg,.vcf,.bed,.gtf,.gff,.gff2,.gff3"
            onChange={onTracksSelected} />
        </div>
      )}

      <span style={{ fontSize: 10, color: theme.textMuted, fontStyle: 'italic' }}>
        {loading ? status || 'Loading\u2026' : 'or drag & drop files'}
      </span>

      {!loading && status && <span style={{ color: '#81c784', fontSize: 11 }}>{status}</span>}
      {(err || trackError) && <span style={{ color: '#ef9a9a', fontSize: 11 }}>{err || trackError}</span>}
    </div>
  )
}
