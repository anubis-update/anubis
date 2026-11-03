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
      prepare () { return { all: () => [{ url: 'https://a.test/p?token=SECRET#f', title: 'A', visit_count: 2, last_visit_time: isoToWebkit('2024-01-02T03:04:05.000Z') }] } }
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
