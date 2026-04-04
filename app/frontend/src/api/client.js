/**
 * client.js — API client for the BiNgo Genome Viewer backend.
 *
 * Wraps all REST calls: genome upload/load, track upload/load/remove,
 * and data fetching (coverage, reads, variants, features).
 *
 * File uploads use XMLHttpRequest for progress tracking.
 */
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

/**
 * Upload a file via XHR with optional progress callback.
 * @param {string} url - API path (e.g. '/genome/load')
 * @param {FormData} fd - Form data with file(s)
 * @param {function} [onProgress] - Called with { loaded, total, percent }
 * @returns {Promise<{data: object}>}
 */
function uploadFile(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api${url}`)

    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress({
            loaded: e.loaded,
            total: e.total,
            percent: Math.round((e.loaded / e.total) * 100),
          })
        }
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve({ data: JSON.parse(xhr.responseText) })
        } catch {
          resolve({ data: {} })
        }
      } else {
        const err = new Error('Upload failed')
        try {
          err.response = { status: xhr.status, data: JSON.parse(xhr.responseText) }
        } catch {
          err.response = { status: xhr.status, data: { detail: xhr.statusText } }
        }
        reject(err)
      }
    })

    xhr.addEventListener('error', () => {
      const err = new Error('Network error')
      err.response = { status: 0, data: { detail: 'Network error — is the server running?' } }
      reject(err)
    })

    xhr.addEventListener('abort', () => {
      const err = new Error('Upload aborted')
      err.name = 'CanceledError'
      reject(err)
    })

    xhr.send(fd)
  })
}

export const genomeApi = {
  load: (file, onProgress) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadFile('/genome/load', fd, onProgress)
  },
  loadPath: (path) => {
    const fd = new FormData()
    fd.append('path', path)
    return uploadFile('/genome/load-path', fd)
  },
  addChromosomes: (file, onProgress) => {
    const fd = new FormData()
    fd.append('file', file)
    return uploadFile('/genome/add-chromosomes', fd, onProgress)
  },
  chromosomes: () => api.get('/genome/chromosomes'),
  sequence: (chrom, start, end) => api.get('/genome/sequence', { params: { chrom, start, end } }),
}

export const tracksApi = {
  /**
   * Upload a track file. For BAM files, pass the matching .bai as `indexFile`.
   */
  load: (file, name, indexFile, onProgress) => {
    const fd = new FormData()
    fd.append('file', file)
    if (name) fd.append('name', name)
    if (indexFile) fd.append('index', indexFile)
    return uploadFile('/tracks/load', fd, onProgress)
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
