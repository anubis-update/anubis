const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  CONTEXT_ROUTE,
  intentKey,
  isUserContext,
  decideContextAction,
  CONTEXT_NOTES,
  noteFor
} = require('../../client/components/web/web-context')

const userCtx = (id, sessionId = 2) => ({
  id,
  target: 'user',
  identity: { sid: 'S-1-5-21-1-2-3-1001', account: 'VM\\root', sessionId }
})
const systemCtx = (id = 'sys') => ({
  id,
  target: 'system',
  identity: { sid: 'S-1-5-18', account: 'SYSTEM', sessionId: 0 }
})

test('CONTEXT_ROUTE is the shipped managed endpoint', () => {
  assert.equal(CONTEXT_ROUTE, '/_anubis/contexts')
})

test('intentKey is scoped per tab id', () => {
  assert.equal(intentKey('abc'), 'anubisBrowserEngine:abc')
  assert.notEqual(intentKey('a'), intentKey('b'))
})

test('isUserContext matches only target user', () => {
  assert.equal(isUserContext(userCtx('u')), true)
  assert.equal(isUserContext(systemCtx()), false)
  assert.equal(isUserContext(null), false)
})

test('decideContextAction selects the single signed-in user context', () => {
  const result = decideContextAction({ supported: true, contexts: [systemCtx(), userCtx('u1')] })
  assert.deepEqual(result, { action: 'select', id: 'u1' })
})

test('decideContextAction flags multiple signed-in users for explicit choice', () => {
  const result = decideContextAction({ supported: true, contexts: [userCtx('u1'), userCtx('u2', 3)] })
  assert.deepEqual(result, { action: 'multiple' })
})

test('decideContextAction reports none when no user context exists', () => {
  const result = decideContextAction({ supported: true, contexts: [systemCtx()] })
  assert.deepEqual(result, { action: 'none' })
})

test('decideContextAction reports unsupported for an unsupported/!ok catalog', () => {
  assert.deepEqual(decideContextAction({ supported: false }), { action: 'unsupported' })
  assert.deepEqual(decideContextAction(null), { action: 'unsupported' })
  assert.deepEqual(decideContextAction({ supported: true }), { action: 'unsupported' })
})

test('noteFor returns neutral English guidance for each non-select action', () => {
  for (const action of ['multiple', 'none', 'unsupported', 'error']) {
    assert.equal(noteFor(action), CONTEXT_NOTES[action])
    assert.ok(noteFor(action).length > 0)
    assert.doesNotMatch(noteFor(action), /success/i)
  }
  assert.equal(noteFor('select'), '')
})
