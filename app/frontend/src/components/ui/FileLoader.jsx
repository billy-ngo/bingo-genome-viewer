/**
 * FileLoader.jsx — Drag-and-drop file upload panel.
 *
 * Accepts genome files (FASTA, GenBank) and track files (BAM, BigWig, WIG,
 * VCF, BED, GTF, GFF). Uploads to the backend and adds to the track list.
 */
import React, { useState, useRef } from 'react'
import { genomeApi } from '../../api/client'
import { useBrowser } from '../../store/BrowserContext'
import { useTracks } from '../../store/TrackContext'
import { useTheme } from '../../store/ThemeContext'

export default function FileLoader() {
  const { theme } = useTheme()
  const { genome, setGenome, navigateTo } = useBrowser()
  const { addTrack, addGenomeAnnotationTrack, error: trackError, setError } = useTracks()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [status, setStatus] = useState(null)
  const [genomeFile, setGenomeFile] = useState(null)
  const trackInputRef = useRef(null)

  const S = {
    panel: {
      background: theme.panelBg, borderBottom: `1px solid ${theme.border}`,
      padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    },
    group: { display: 'flex', alignItems: 'center', gap: 6 },
    label: { fontSize: 11, color: theme.textSecondary, textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' },
    fileInput: {
      background: theme.inputBg, border: `1px solid ${theme.borderAccent}`, borderRadius: 4,
      color: theme.textPrimary, padding: '4px 6px', fontSize: 12, width: 220,
    },
    btn: {
      background: theme.btnBg, border: 'none', borderRadius: 4, color: theme.btnText,
      padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
  }

  async function loadGenome() {
    if (!genomeFile) { setErr('Please choose a genome file first.'); return }
    setLoading(true); setErr(null); setStatus(null)
    try {
      const res = await genomeApi.load(genomeFile)
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
    } catch (e) { setErr(e.response?.data?.detail || e.message) }
    finally { setLoading(false) }
  }

  async function loadTracks() {
    const input = trackInputRef.current
    if (!input?.files?.length) { setErr('Please choose one or more track files.'); return }
    const files = Array.from(input.files)
    setLoading(true); setErr(null); setError(null)
    setStatus(`Loading ${files.length} track${files.length > 1 ? 's' : ''}...`)
    const errors = []
    for (const file of files) {
      try { await addTrack(file, undefined) }
      catch (e) { errors.push(`${file.name}: ${e.response?.data?.detail || e.message}`) }
    }
    input.value = ''
    setLoading(false)
    if (errors.length) { setErr(errors.join('; ')); setStatus(null) }
    else { setStatus(`Added ${files.length} track${files.length > 1 ? 's' : ''}.`); setTimeout(() => setStatus(null), 3000) }
  }

  return (
    <div style={S.panel}>
      <div style={S.group}>
        <span style={S.label}>Genome</span>
        <input type="file" style={S.fileInput} disabled={loading}
          onChange={e => { setGenomeFile(e.target.files?.[0] || null); setErr(null) }} />
        <button style={S.btn} onClick={loadGenome} disabled={loading}>
          {loading ? 'Loading\u2026' : 'Load'}
        </button>
      </div>
      {genome && (
        <div style={S.group}>
          <span style={S.label}>Tracks</span>
          <input ref={trackInputRef} type="file" multiple style={S.fileInput} disabled={loading} />
          <button style={S.btn} onClick={loadTracks} disabled={loading}>Add Tracks</button>
        </div>
      )}
      {status && <span style={{ color: '#81c784', fontSize: 11 }}>{status}</span>}
      {(err || trackError) && <span style={{ color: '#ef9a9a', fontSize: 11 }}>{err || trackError}</span>}
    </div>
  )
}
