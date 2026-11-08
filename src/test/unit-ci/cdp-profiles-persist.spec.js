const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProfileCatalog } = require('../../app/lib/cdp-profiles')

const state = { profile: { info_cache: { Default: { name: 'A' }, 'Profile 1': { name: 'B' } } } }
const mk = (persist, st = state) => createProfileCatalog({ readFile: () => JSON.stringify(st), exists: () => true, resolveSourceDir: () => 'r', persist })

test('select persists only opaque ids and survives a restart', () => {
  let disk = {}
  const persist = { read: () => disk, write: (o) => { disk = JSON.parse(JSON.stringify(o)) } }
  const a = mk(persist)
  const id = a.enumerate('chrome').profiles[1].profileId
  assert.equal(a.select('chrome', id), true)
  assert.deepEqual(disk, { chrome: id })
  assert.ok(!JSON.stringify(disk).includes('Profile 1'))
  const b = mk(persist)
  assert.equal(b.selected('chrome'), id)
  assert.deepEqual(b.resolve(id), { engine: 'chrome', dir: 'Profile 1' })
})

test('stale or tampered persisted selection is dropped', () => {
  const gone = mk({ read: () => ({ chrome: 'p_0000000000' }), write () {} })
  assert.equal(gone.selected('chrome'), null)
  const evil = mk({ read: () => ({ chrome: '../../x', 'bad engine': 'p_0000000000' }), write () {} })
  assert.equal(evil.selected('chrome'), null)
  const broken = mk({ read: () => { throw new Error('x') }, write () { throw new Error('y') } })
  assert.equal(broken.selected('chrome'), null)
  assert.throws(() => broken.select('chrome', broken.enumerate('chrome').profiles[0].profileId), /y/)
  assert.equal(broken.selected('chrome'), null)
})
