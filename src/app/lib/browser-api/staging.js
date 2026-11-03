/**
 * Quarantine ("staged") area. Agents never send filesystem paths: they refer to
 * entries by an opaque `stagedId` (a single path segment) that this module
 * resolves strictly inside one allowlisted root. Symlinks, traversal, devices
 * and oversized entries are rejected.
 */

const fs = require('node:fs')
const path = require('node:path')
const { apiError } = require('./errors')

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/
const MAX_FILE_BYTES = 256 * 1024 * 1024

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

  return {
    root: () => rootResolved,
    resolveFile: (stagedId) => entry(stagedId, 'file'),
    resolveDir: (stagedId) => entry(stagedId, 'dir').path,
    resolveFiles (items = []) {
      return items.map((i) => entry(i && i.stagedId, 'file').path)
    }
  }
}

module.exports = { createStaging, ID_RE }
