/**
 * client.js — API client for the Genomics Viewer backend.
 *
 * Wraps all REST calls: genome upload/load, track upload/load/remove,
 * and data fetching (coverage, reads, variants, features).
 */
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

async function uploadFile(url, fd) {
  const res = await fetch(`/api${url}`, { method: 'POST', body: fd })
  if (!res.ok) {
    const err = new Error('Upload failed')
    try { err.response = { status: res.status, data: await res.json() } } catch {}
    throw err
  }
  return { data: await res.json() }
}

export const genomeApi = {
  load: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadFile('/genome/load', fd)
  },
  loadPath: (path) => {
    const fd = new FormData()
    fd.append('path', path)
    return uploadFile('/genome/load-path', fd)
  },
  chromosomes: () => api.get('/genome/chromosomes'),
  sequence: (chrom, start, end) => api.get('/genome/sequence', { params: { chrom, start, end } }),
}

export const tracksApi = {
  load: (file, name) => {
    const fd = new FormData()
    fd.append('file', file)
    if (name) fd.append('name', name)
    return uploadFile('/tracks/load', fd)
  },
  loadPath: (path, name) => {
    const fd = new FormData()
    fd.append('path', path)
    if (name) fd.append('name', name)
    return uploadFile('/tracks/load-path', fd)
  },
  list: () => api.get('/tracks'),
  remove: (id) => api.delete(`/tracks/${id}`),
  coverage: (id, chrom, start, end, bins = 1000) =>
    api.get(`/tracks/${id}/coverage`, { params: { chrom, start, end, bins } }),
  reads: (id, chrom, start, end) =>
    api.get(`/tracks/${id}/reads`, { params: { chrom, start, end } }),
  variants: (id, chrom, start, end) =>
    api.get(`/tracks/${id}/variants`, { params: { chrom, start, end } }),
  features: (id, chrom, start, end) =>
    api.get(`/tracks/${id}/features`, { params: { chrom, start, end } }),
}

export default api
