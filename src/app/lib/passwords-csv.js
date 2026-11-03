/**
 * Password CSV handling primitives. Password import/export go through the
 * browser's own UI/CSV flow, which this build cannot complete without driving
 * native file dialogs (see command-handlers: CAPABILITY_MISSING). What IS
 * implemented: header validation of a staged CSV (contents are never returned)
 * and immediate AES-256-GCM encryption of any plaintext CSV that appears, with
 * best-effort overwrite and deletion of the plaintext.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const { apiError } = require('./browser-api/errors')

const MAGIC = Buffer.from('ABPW1')
const MAX_CSV = 32 * 1024 * 1024

// Chrome/Edge password CSV: name,url,username,password[,note]
function validateCsvHeader (firstLine) {
  const cols = String(firstLine || '').replace(/^\uFEFF/, '').trim().toLowerCase().split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
  return cols.includes('url') && cols.includes('username') && cols.includes('password')
}

function encryptBuffer (plain, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key must be 32 bytes')
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct])
}

function decryptBuffer (blob, key) {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted password file')
  const iv = blob.subarray(5, 17)
  const tag = blob.subarray(17, 33)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(blob.subarray(33)), d.final()])
}

function createPasswordVault ({ key, fsApi = fs } = {}) {
  function inspectStaged (filePath) {
    const st = fsApi.statSync(filePath)
    if (!st.isFile() || st.size > MAX_CSV) throw apiError('INVALID_REQUEST', 'Staged CSV is not usable')
    const fd = fsApi.openSync(filePath, 'r')
    let head
    try {
      const buf = Buffer.alloc(Math.min(512, st.size))
      fsApi.readSync(fd, buf, 0, buf.length, 0)
      head = buf.toString('utf8').split(/\r?\n/)[0]
    } finally { fsApi.closeSync(fd) }
    if (!validateCsvHeader(head)) throw apiError('INVALID_REQUEST', 'Staged file is not a browser password CSV')
    return { bytes: st.size }
  }

  // Replaces `src` with `dst` (encrypted); contents never leave this function.
  function sealFile (src, dst) {
    const plain = fsApi.readFileSync(src)
    try {
      fsApi.writeFileSync(dst, encryptBuffer(plain, key), { mode: 0o600 })
    } finally {
      try { fsApi.writeFileSync(src, Buffer.alloc(plain.length)) } catch {}
      try { fsApi.unlinkSync(src) } catch {}
      plain.fill(0)
    }
    return { sealed: true }
  }

  return { inspectStaged, sealFile }
}

module.exports = { createPasswordVault, validateCsvHeader, encryptBuffer, decryptBuffer }
