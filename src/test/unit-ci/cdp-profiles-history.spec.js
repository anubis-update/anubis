const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProfileCatalog, maskEmail } = require('../../app/lib/cdp-profiles')
const { createHistoryReader, webkitToIso, isoToWebkit } = require('../../app/lib/cdp-history')

test('profile enumeration is read-only, masks email, hides paths, skips ghosts', () => {
  const state = { profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Person 1', user_name: 'alice@example.com' }, 'Profile 1': { name: 'Work' }, Ghost: { name: 'x' }, '../evil': { name: 'e' } } } }
  const cat = createProfileCatalog({
    readFile: () => JSON.stringify(state),
    exists: (p) => !p.includes('Ghost'),
    resolveSourceDir: () => 'C:\\secret\\root'
  })
  const r = cat.enumerate('chrome')
  assert.equal(r.profiles.length, 2)
  assert.equal(r.profiles[0].email, 'a***@example.com')
  assert.ok(!JSON.stringify(r).includes('secret'))
  assert.ok(!JSON.stringify(r).includes('alice'))
  const id = r.profiles[1].profileId
  assert.deepEqual(cat.resolve(id), { engine: 'chrome', dir: 'Profile 1' })
  assert.equal(cat.select('chrome', id), true)
  assert.equal(cat.select('edge', id), false)
  assert.equal(cat.selected('chrome'), id)
})

test('missing or corrupt Local State is unavailable, not an error', () => {
  const cat = createProfileCatalog({ readFile: () => { throw new Error('x') }, resolveSourceDir: () => 'r' })
  assert.deepEqual(cat.enumerate('chrome'), { profiles: [], available: false })
  assert.equal(maskEmail('nope'), undefined)
})

test('profile refresh discards removed directories and preserves other engines', () => {
  let state = { profile: { info_cache: { Default: { name: 'Main' } } } }
  const cat = createProfileCatalog({
    resolveSourceDir: engine => engine,
    exists: () => true,
    readFile: () => JSON.stringify(state)
  })
  const chrome = cat.enumerate('chrome').profiles[0].profileId
  const edge = cat.enumerate('edge').profiles[0].profileId
  cat.select('chrome', chrome)
  state = { profile: { info_cache: {} } }
  cat.enumerate('chrome')
  assert.equal(cat.resolve(chrome), null)
  assert.equal(cat.selected('chrome'), null)
  assert.equal(cat.resolve(edge).engine, 'edge')
})

test('profile persistence failures are reported without changing the selected profile', () => {
  const cat = createProfileCatalog({
    resolveSourceDir: () => 'root',
    exists: () => true,
    readFile: () => JSON.stringify({ profile: { info_cache: { Default: {} } } }),
    persist: { read: () => ({}), write: () => { throw new Error('disk full') } }
  })
  const id = cat.enumerate('chrome').profiles[0].profileId
  assert.throws(() => cat.select('chrome', id), /disk full/)
  assert.equal(cat.selected('chrome'), null)
})

test('history: unavailable without sqlite', () => {
  const h = createHistoryReader({ sqlite: null })
  assert.equal(h.available, false)
  assert.deepEqual(h.search({ historyPath: 'x' }), { available: false, entries: [] })
})

test('history reads a scratch copy and always removes it', () => {
  const removed = []
  const copied = []
  let opened
  const sqlite = {
    DatabaseSync: class {
      constructor (p, o) { opened = { p, o } }
      prepare () {
        return {
          setReadBigInts: value => assert.equal(value, true),
          all: () => [{ url: 'https://a.test/p?token=SECRET#f', title: 'A', visit_count: 2n, last_visit_time: isoToWebkit('2024-01-02T03:04:05.000Z') }]
        }
      }

      close () {}
    }
  }
  const h = createHistoryReader({
    sqlite,
    scratchDir: 'scratch',
    exists: () => true,
    copyFile: (a, b) => copied.push([a, b]),
    removeFile: (p) => removed.push(p)
  })
  const r = h.search({ historyPath: 'live\\History', text: 'a' })
  assert.equal(opened.o.readOnly, true)
  assert.notEqual(opened.p, 'live\\History')
  assert.equal(r.entries[0].url, 'https://a.test/p')
  assert.equal(r.entries[0].lastVisitTime, '2024-01-02T03:04:05.000Z')
  assert.ok(removed.includes(opened.p))
  assert.ok(copied.length >= 1)
})

test('webkit time conversion round-trips', () => {
  const iso = '2020-05-06T07:08:09.000Z'
  assert.equal(webkitToIso(isoToWebkit(iso)), iso)
})

test('real SQLite history preserves Chromium timestamps larger than Number.MAX_SAFE_INTEGER', () => {
  const { DatabaseSync } = require('node:sqlite')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-history-test-'))
  const file = path.join(root, 'History')
  try {
    const db = new DatabaseSync(file)
    try {
      db.exec('CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)')
      const timestamp = isoToWebkit('2026-11-03T12:00:00.000Z')
      assert.ok(timestamp > BigInt(Number.MAX_SAFE_INTEGER))
      db.prepare('INSERT INTO urls VALUES (?, ?, ?, ?)').run('https://example.test/', 'Real history', 3, timestamp)
    } finally { db.close() }
    const reader = createHistoryReader({ scratchDir: root })
    const result = reader.search({ historyPath: file, text: 'Real', since: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(result.entries, [{
      url: 'https://example.test/', title: 'Real history', visitCount: 3, lastVisitTime: '2026-11-03T12:00:00.000Z'
    }])
    assert.deepEqual(fs.readdirSync(root), ['History'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
