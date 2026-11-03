/**
 * Tamper-evident audit log: JSONL per day, each record carries
 * hash = sha256(prevHash || canonicalJSON(record without hash)).
 * Sensitive params/results are stored only as {len, sha256Prefix8} digests.
 * The filesystem is injected (append, read, list) so tests use memory.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { canonical } = require('./idempotency-cache')

const SENSITIVE_KEYS = new Set(['text', 'expression', 'cookies', 'entries', 'values', 'password', 'passwords', 'value', 'files', 'headers', 'authorization', 'token', 'secret', 'fields'])
const GENESIS = '0'.repeat(64)

function digest (v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v) || ''
  return { len: s.length, sha256Prefix8: crypto.createHash('sha256').update(s).digest('hex').slice(0, 8) }
}

function sanitize (v, depth = 0) {
  if (depth > 6) return '[deep]'
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1))
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) {
      o[k] = SENSITIVE_KEYS.has(k) ? digest(v[k]) : sanitize(v[k], depth + 1)
    }
    return o
  }
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  return v
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid (t = Date.now()) {
  let ts = ''
  for (let i = 0, n = t; i < 10; i++) { ts = CROCKFORD[n % 32] + ts; n = Math.floor(n / 32) }
  let rnd = ''
  const b = crypto.randomBytes(16)
  for (let i = 0; i < 16; i++) rnd += CROCKFORD[b[i] % 32]
  return ts + rnd
}

function nodeFs (dir) {
  return {
    append (name, line) {
      fs.mkdirSync(dir, { recursive: true })
      const fd = fs.openSync(path.join(dir, name), 'a', 0o600)
      try { fs.writeSync(fd, line); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    },
    read (name) { try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return '' } },
    list () { try { return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort() } catch { return [] } },
    remove (name) { try { fs.rmSync(path.join(dir, name), { force: true }) } catch {} }
  }
}

function createAuditLog ({ fsApi, dir, now = () => Date.now(), retainDays = 90 } = {}) {
  const io = fsApi || nodeFs(dir)
  let prevHash = null

  function lastHash () {
    if (prevHash) return prevHash
    const files = io.list()
    for (let i = files.length - 1; i >= 0; i--) {
      const lines = io.read(files[i]).split('\n').filter(Boolean)
      if (lines.length) {
        try { prevHash = JSON.parse(lines[lines.length - 1]).hash; return prevHash } catch {}
      }
    }
    prevHash = GENESIS
    return prevHash
  }

  function record (entry) {
    const t = now()
    const base = { v: 1, id: ulid(t), ts: new Date(t).toISOString(), ...entry }
    if (base.paramsDigest !== undefined) base.paramsDigest = sanitize(base.paramsDigest)
    if (base.outcome && base.outcome.resultDigest !== undefined) base.outcome = { ...base.outcome, resultDigest: digest(base.outcome.resultDigest) }
    const prevForRec = lastHash()
    const hash = crypto.createHash('sha256').update(prevForRec + canonical({ ...base, prevHash: prevForRec })).digest('hex')
    const rec = { ...base, prevHash: prevForRec, hash }
    io.append(base.ts.slice(0, 10) + '.jsonl', JSON.stringify(rec) + '\n')
    prevHash = rec.hash
    return rec
  }

  function verify () {
    let prev = null
    let count = 0
    for (const f of io.list()) {
      for (const line of io.read(f).split('\n').filter(Boolean)) {
        let r
        try { r = JSON.parse(line) } catch { return { ok: false, count, brokenAt: count } }
        const { hash, ...base } = r
        const ph = r.prevHash
        if (prev !== null && ph !== prev) return { ok: false, count, brokenAt: count }
        if (crypto.createHash('sha256').update(ph + canonical(base)).digest('hex') !== hash) return { ok: false, count, brokenAt: count }
        prev = hash
        count++
      }
    }
    return { ok: true, count }
  }

  function query ({ limit = 100, command, actorId } = {}) {
    const out = []
    const files = io.list().reverse()
    for (const f of files) {
      const lines = io.read(f).split('\n').filter(Boolean).reverse()
      for (const line of lines) {
        let r
        try { r = JSON.parse(line) } catch { continue }
        if (command && r.command !== command) continue
        if (actorId && (!r.actor || r.actor.id !== actorId)) continue
        out.push(r)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  function prune () {
    const cutoff = new Date(now() - retainDays * 86400000).toISOString().slice(0, 10)
    for (const f of io.list()) if (f.slice(0, 10) < cutoff && io.remove) io.remove(f)
  }

  return { record, verify, query, prune }
}

module.exports = { createAuditLog, sanitize, digest, ulid }
