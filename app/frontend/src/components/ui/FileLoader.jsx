/**
 * FileLoader.jsx — File upload panel with file-picker inputs.
 *
 * Accepts genome files (FASTA, GenBank) and track files (BAM, BigWig, WIG,
 * VCF, BED, GTF, GFF). Files load automatically when selected.
 * Drag-and-drop is handled at the App level (full-screen drop zone).
 */
import React, { useState, useRef } from 'react'
import { genomeApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks, cleanName } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

export default function FileLoader() {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const { addTrack, addGenomeAnnotationTrack, error: trackError, setError } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
  const genomeInputRef = useRef(null)
  const trackInputRef = useRef(null)

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
      color: theme.textPrimary, padding: '4px 6px', fontSize: 12, width: 220, cursor: 'pointer',
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

  return (
    <div style={S.panel}>
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
