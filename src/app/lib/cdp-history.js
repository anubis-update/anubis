/**
 * Browser history via a read-only COPY of the profile's History SQLite file,
 * read with the built-in node:sqlite (no new dependency). If the module is not
 * available the capability is reported unavailable. The live DB is never
 * opened or written; the scratch copy is always deleted.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const WEBKIT_EPOCH_DIFF_US = 11644473600000000n

function loadSqlite () {
  try { return require('node:sqlite') } catch { return null }
}

function webkitToIso (us) {
  const ms = Number((BigInt(us) - WEBKIT_EPOCH_DIFF_US) / 1000n)
  return new Date(ms).toISOString()
}

function isoToWebkit (iso) {
  return BigInt(new Date(iso).getTime()) * 1000n + WEBKIT_EPOCH_DIFF_US
}

function createHistoryReader ({
  sqlite = loadSqlite(),
  copyFile = fs.copyFileSync,
  removeFile = (p) => fs.rmSync(p, { force: true }),
  exists = fs.existsSync,
  scratchDir = os.tmpdir()
} = {}) {
  const available = !!(sqlite && sqlite.DatabaseSync)

  function search ({ historyPath, text, since, until, limit = 50 }) {
    if (!available) return { available: false, entries: [] }
    if (!historyPath || !exists(historyPath)) return { available: true, entries: [] }
    const scratch = path.join(scratchDir, 'anubis-hist-' + crypto.randomBytes(6).toString('hex'))
    const extra = []
    try {
      copyFile(historyPath, scratch)
      for (const suffix of ['-wal', '-journal']) {
        if (exists(historyPath + suffix)) { copyFile(historyPath + suffix, scratch + suffix); extra.push(scratch + suffix) }
      }
      const db = new sqlite.DatabaseSync(scratch, { readOnly: true })
      try {
        const where = []
        const args = []
        if (text) { where.push('(url LIKE ? OR title LIKE ?)'); args.push('%' + text + '%', '%' + text + '%') }
        if (since) { where.push('last_visit_time >= ?'); args.push(isoToWebkit(since)) }
        if (until) { where.push('last_visit_time <= ?'); args.push(isoToWebkit(until)) }
        const sql = 'SELECT url, title, visit_count, last_visit_time FROM urls' +
          (where.length ? ' WHERE ' + where.join(' AND ') : '') +
          ' ORDER BY last_visit_time DESC LIMIT ?'
        args.push(Math.min(Math.max(1, limit), 500))
        const rows = db.prepare(sql).all(...args)
        return {
          available: true,
          entries: rows.map((r) => ({
            url: String(r.url).split(/[?#]/)[0],
            title: String(r.title || '').slice(0, 200),
            visitCount: Number(r.visit_count),
            lastVisitTime: webkitToIso(r.last_visit_time)
          }))
        }
      } finally {
        try { db.close() } catch {}
      }
    } finally {
      for (const f of [scratch, ...extra]) { try { removeFile(f) } catch {} }
    }
  }

  return { available, search }
}

module.exports = { createHistoryReader, webkitToIso, isoToWebkit }
