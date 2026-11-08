const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTokenStore } = require('../../app/lib/browser-api/v1-api')

test('list never exposes token material; revoke removes one token only', () => {
  const t = 1000
  const s = createTokenStore({ now: () => t })
  const a = s.issue('agent', 60000, { label: 'my agent' })
  const b = s.issue('operator', 60000)
  const list = s.list()
  assert.equal(list.length, 2)
  assert.ok(!JSON.stringify(list).includes(a))
  assert.ok(!JSON.stringify(list).includes('hash'))
  assert.equal(list[0].label, 'my agent')
  assert.equal(list[0].role, 'agent')
  assert.match(list[0].createdAt, /^\d{4}-/)
  assert.equal(s.revoke(list[0].id), true)
  assert.equal(s.revoke(list[0].id), false)
  assert.equal(s.verify(a), null)
  assert.ok(s.verify(b))
  assert.equal(s.list().length, 1)
})

test('expired tokens vanish from list and verify', () => {
  let t = 0
  const s = createTokenStore({ now: () => t })
  const a = s.issue('agent', 100)
  t = 101
  assert.equal(s.verify(a), null)
  assert.deepEqual(s.list(), [])
})
