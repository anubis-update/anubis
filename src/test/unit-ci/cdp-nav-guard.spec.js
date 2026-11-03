const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createNavGuard } = require('../../app/lib/cdp-nav-guard')
const { createFakeCdp } = require('./browser-hub-fake-cdp')
const { createPolicyEngine, DEFAULT_POLICY } = require('../../app/lib/browser-api/policy-engine')

const tick = () => new Promise((r) => setTimeout(r, 5))

test('enables Fetch for http(s) documents only', async () => {
  const c = createFakeCdp()
  const g = createNavGuard({ client: c, checkUrl: () => ({ ok: true }) })
  await g.attach('S1', 't1')
  const call = c.calls[0]
  assert.equal(call.method, 'Fetch.enable')
  assert.equal(call.sessionId, 'S1')
  assert.deepEqual(call.params.patterns.map((p) => p.urlPattern), ['http://*', 'https://*'])
  assert.ok(call.params.patterns.every((p) => p.resourceType === 'Document'))
})

test('every hop incl. redirect to a private target is checked; blocked hops fail', async () => {
  const c = createFakeCdp()
  const policy = createPolicyEngine({ policy: DEFAULT_POLICY })
  const events = []
  const g = createNavGuard({ client: c, checkUrl: (u) => policy.checkUrl(u), emit: (e, d) => events.push([e, d]) })
  await g.attach('S1', 't1')
  c.emit('Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://example.com/a' } }, 'S1')
  c.emit('Fetch.requestPaused', { requestId: 'r2', redirectedRequestId: 'r1', request: { url: 'http://127.0.0.1:8080/admin?k=SECRET' } }, 'S1')
  c.emit('Fetch.requestPaused', { requestId: 'r3', redirectedRequestId: 'r2', request: { url: 'http://[::ffff:7f00:1]/' } }, 'S1')
  await tick()
  const methods = c.calls.filter((x) => x.method.startsWith('Fetch.') && x.method !== 'Fetch.enable').map((x) => [x.method, x.params.requestId])
  assert.deepEqual(methods, [['Fetch.continueRequest', 'r1'], ['Fetch.failRequest', 'r2'], ['Fetch.failRequest', 'r3']])
  assert.equal(c.calls.find((x) => x.method === 'Fetch.failRequest').params.errorReason, 'BlockedByClient')
  assert.equal(events.length, 2)
  assert.equal(events[0][1].data.redirect, true)
  assert.ok(!JSON.stringify(events).includes('SECRET'))
})

test('non-http requests are continued; check errors fail closed; attach is idempotent per session', async () => {
  const c = createFakeCdp()
  let boom = false
  const g = createNavGuard({ client: c, checkUrl: () => { if (boom) throw new Error('x'); return { ok: true } } })
  await g.attach('S1', 't1')
  await g.attach('S1', 't1')
  c.emit('Fetch.requestPaused', { requestId: 'a', request: { url: 'data:text/html,hi' } }, 'S1')
  boom = true
  c.emit('Fetch.requestPaused', { requestId: 'b', request: { url: 'https://x.test/' } }, 'S1')
  await tick()
  const decisions = c.calls.filter((x) => /continue|fail/.test(x.method)).map((x) => x.method)
  assert.deepEqual(decisions, ['Fetch.continueRequest', 'Fetch.failRequest'])
})
