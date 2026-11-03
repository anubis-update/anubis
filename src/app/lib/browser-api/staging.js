/**
 * Quarantine ("staged") area. Agents never send filesystem paths: they refer to
 * entries by an opaque `stagedId` (a single path segment) that this module
 * resolves strictly inside one allowlisted root. Symlinks, traversal, devices
 * and oversized entries are rejected.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { apiError } = require('./errors')

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_DIR_FILES = 2000
const MAX_DIR_BYTES = 64 * 1024 * 1024

function createStaging ({ root, fsApi = fs, maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!root || !path.isAbsolute(root)) throw new TypeError('staging requires an absolute root')
  const rootResolved = path.resolve(root)

  function inside (p) {
    const rel = path.relative(rootResolved, p)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  function entry (stagedId, kind) {
    if (typeof stagedId !== 'string' || !ID_RE.test(stagedId) || stagedId.endsWith('.') || stagedId.endsWith(' ')) {
      throw apiError('INVALID_REQUEST', 'Invalid stagedId')
    }
    const full = path.join(rootResolved, stagedId)
    if (!inside(full)) throw apiError('INVALID_REQUEST', 'Invalid stagedId')
    let st
    try { st = fsApi.lstatSync(full) } catch { throw apiError('INVALID_REQUEST', 'Unknown stagedId') }
    if (st.isSymbolicLink()) throw apiError('INVALID_REQUEST', 'Staged entry must not be a symbolic link')
    if (kind === 'file' && !st.isFile()) throw apiError('INVALID_REQUEST', 'Staged entry is not a regular file')
    if (kind === 'dir' && !st.isDirectory()) throw apiError('INVALID_REQUEST', 'Staged entry is not a folder')
    if (kind === 'file' && st.size > maxFileBytes) throw apiError('LIMIT_EXCEEDED', 'Staged file is too large')
    if (typeof fsApi.realpathSync === 'function') {
      let real
      try { real = fsApi.realpathSync(full) } catch { throw apiError('INVALID_REQUEST', 'Unknown stagedId') }
      if (!inside(path.resolve(real)) && path.resolve(real) !== full) throw apiError('INVALID_REQUEST', 'Staged entry escapes the staging area')
    }
    return { path: full, size: st.size }
  }

  const newId = (src) => {
    const base = path.basename(src).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').replace(/[. ]+$/, '').slice(0, 80) || 'item'
    return 'st_' + crypto.randomBytes(4).toString('hex') + '-' + base
  }

  // Copies a user-chosen local file or folder into the staging root (UI only).
  function importPath (src) {
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw apiError('INVALID_REQUEST', 'An absolute source path is required')
    let st
    try { st = fsApi.lstatSync(src) } catch { throw apiError('INVALID_REQUEST', 'Source does not exist') }
    if (st.isSymbolicLink()) throw apiError('INVALID_REQUEST', 'Source must not be a symbolic link')
    const stagedId = newId(src)
    const dest = path.join(rootResolved, stagedId)
    fsApi.mkdirSync(rootResolved, { recursive: true })
    if (st.isFile()) {
      if (st.size > maxFileBytes) throw apiError('LIMIT_EXCEEDED', 'File is too large')
      fsApi.copyFileSync(src, dest)
      return { stagedId, kind: 'file', size: st.size }
    }
    if (!st.isDirectory()) throw apiError('INVALID_REQUEST', 'Source must be a file or folder')
    const totals = { files: 0, bytes: 0 }
    const copyDir = (from, to) => {
      fsApi.mkdirSync(to, { recursive: true })
      for (const name of fsApi.readdirSync(from)) {
        const f = path.join(from, name)
        const s = fsApi.lstatSync(f)
        if (s.isSymbolicLink()) throw apiError('INVALID_REQUEST', 'Folder contains a symbolic link')
        if (s.isDirectory()) { copyDir(f, path.join(to, name)); continue }
        if (!s.isFile()) throw apiError('INVALID_REQUEST', 'Folder contains an unsupported entry')
        totals.files++
        totals.bytes += s.size
        if (totals.files > MAX_DIR_FILES || totals.bytes > MAX_DIR_BYTES) throw apiError('LIMIT_EXCEEDED', 'Folder is too large')
        fsApi.copyFileSync(f, path.join(to, name))
      }
    }
    try { copyDir(src, dest) } catch (e) {
      try { fsApi.rmSync(dest, { recursive: true, force: true }) } catch {}
      throw e
    }
    return { stagedId, kind: 'dir', files: totals.files, size: totals.bytes }
  }

  return {
    root: () => rootResolved,
    importPath,
    resolveFile: (stagedId) => entry(stagedId, 'file'),
    resolveDir: (stagedId) => entry(stagedId, 'dir').path,
    resolveFiles (items = []) {
      return items.map((i) => entry(i && i.stagedId, 'file').path)
    }
  }
}

module.exports = { createStaging, ID_RE }
