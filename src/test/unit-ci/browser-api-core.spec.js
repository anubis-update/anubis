const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRedactor } = require('../../app/lib/browser-api/redactor')
const { createPolicyEngine, isPrivateHost, DEFAULT_POLICY } = require('../../app/lib/browser-api/policy-engine')
const { createIdempotencyCache, hashRequest } = require('../../app/lib/browser-api/idempotency-cache')
const { createLeaseManager } = require('../../app/lib/browser-api/lease-manager')
const { createAuditLog } = require('../../app/lib/browser-api/audit-log')
const { createEventBus } = require('../../app/lib/browser-api/event-bus')
const { createConfirmations } = require('../../app/lib/browser-api/confirmations')
const registry = require('../../app/lib/browser-api/registry.json')

test('redactor strips known secrets in all encodings, deep, and counts', () => {
  const r = createRedactor({ maskPatterns: ['tok_[a-z]+'] })
  r.addSecret('hunter2!')
  const secret = 'hunter2!'
  const input = { a: ['x ' + secret], b: encodeURIComponent(secret), c: Buffer.from(secret).toString('base64'), d: 'tok_abc', [secret]: 1 }
  const out = r.redact(input)
  const s = JSON.stringify(out.value)
  assert.ok(!s.includes(secret) && !s.includes('tok_abc') && !s.includes(encodeURIComponent(secret)))
  assert.ok(out.count >= 4)
})

test('policy: agent default-deny matrix for sensitive/dangerous commands', () => {
  const p = createPolicyEngine()
  for (const c of registry.commands) {
    const e = p.evaluate({ role: 'agent', command: c.name, risk: c.risk }).effect
    if (c.risk === 'dangerous') assert.equal(e, 'deny', c.name)
    if (c.risk === 'sensitive') assert.notEqual(e, 'allow', c.name)
    if (c.risk === 'read' || c.risk === 'write') assert.notEqual(e, 'deny', c.name + ' ' + e)
  }
  assert.equal(p.evaluate({ role: 'agent', command: 'page.evaluate', risk: 'dangerous' }).effect, 'deny')
  assert.equal(p.evaluate({ role: 'agent', command: 'cookies.export', risk: 'sensitive' }).effect, 'deny')
  assert.equal(p.evaluate({ role: 'agent', command: 'unknown.cmd', risk: 'sensitive' }).effect, 'deny')
  assert.equal(p.evaluate({ role: 'operator', command: 'devMode.set', risk: 'dangerous' }).effect, 'confirm')
  assert.equal(p.evaluate({ role: 'nobody', command: 'tab.list', risk: 'read' }).effect, 'deny')
})

test('policy: explicit allow overrides default for sensitive; overlay can only add denies', () => {
  const policy = JSON.parse(JSON.stringify(DEFAULT_POLICY))
  policy.roles.agent.rules.unshift({ command: 'history.list', effect: 'allow' })
  const p = createPolicyEngine({ policy, adminOverlay: { roles: { agent: { rules: [{ command: 'tab.close', effect: 'deny' }] } }, limits: { maxTabsPerBrowser: 3 } } })
  assert.equal(p.evaluate({ role: 'agent', command: 'history.list', risk: 'sensitive' }).effect, 'allow')
  assert.equal(p.evaluate({ role: 'agent', command: 'tab.close', risk: 'write' }).effect, 'deny')
  assert.equal(p.limits().maxTabsPerBrowser, 3)
})

test('policy: URL checks block schemes, private nets, IPv6-mapped, lists', () => {
  const p = createPolicyEngine({ adminOverlay: { domains: { deny: ['evil.test'] } } })
  for (const u of ['file:///c:/x', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x', 'http://127.0.0.1/', 'http://localhost:8080/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://169.254.169.254/', 'https://sub.evil.test/']) {
    assert.equal(p.checkUrl(u).ok, false, u)
  }
  assert.equal(p.checkUrl('https://example.com/a').ok, true)
  assert.equal(p.checkUrl('about:blank').ok, true)
  assert.equal(isPrivateHost('8.8.8.8'), false)
  const al = createPolicyEngine({ policy: { ...DEFAULT_POLICY, domains: { ...DEFAULT_POLICY.domains, mode: 'allowlist', allow: ['*.ok.test'] } } })
  assert.equal(al.checkUrl('https://a.ok.test/').ok, true)
  assert.equal(al.checkUrl('https://b.test/').ok, false)
})

test('idempotency: replay, conflict, pending join, TTL, LRU', async () => {
  let t = 0
  const c = createIdempotencyCache({ ttlMs: 1000, max: 2, now: () => t })
  const h = hashRequest('tab.close', { a: 1 })
  assert.equal(c.begin('x', 'r1', h).state, 'new')
  const pend = c.begin('x', 'r1', h)
  assert.equal(pend.state, 'pending')
  c.finish('x', 'r1', { ok: true })
  assert.deepEqual(await pend.promise, { ok: true })
  assert.equal(c.begin('x', 'r1', h).state, 'replay')
  assert.equal(c.begin('x', 'r1', hashRequest('tab.close', { a: 2 })).state, 'conflict')
  t = 2000
  assert.equal(c.begin('x', 'r1', h).state, 'new')
  assert.equal(hashRequest('c', { a: 1, b: 2 }), hashRequest('c', { b: 2, a: 1 }))
})

test('leases: exclusivity, expiry, takeover, operator bypass', () => {
  let t = 0
  const l = createLeaseManager({ now: () => t })
  const a = l.acquire({ browserId: 'b1', actor: 'agentA', ttlMs: 5000 })
  assert.throws(() => l.acquire({ browserId: 'b1', actor: 'agentB' }), (e) => e.code === 'BUSY')
  assert.throws(() => l.check({ browserId: 'b1', actor: 'agentA', role: 'agent' }), (e) => e.code === 'LEASE_REQUIRED')
  l.check({ browserId: 'b1', actor: 'agentA', role: 'agent', leaseId: a.leaseId })
  l.check({ browserId: 'b1', actor: 'human', role: 'operator' })
  assert.throws(() => l.check({ browserId: 'b1', actor: 'agentB', role: 'agent' }), (e) => e.code === 'BUSY')
  assert.equal(l.takeover('b1'), true)
  assert.throws(() => l.check({ browserId: 'b1', actor: 'agentA', role: 'agent', leaseId: a.leaseId }), (e) => e.code === 'LEASE_EXPIRED')
  const b = l.acquire({ browserId: 'b2', actor: 'agentA', ttlMs: 2000 })
  t = 3000
  assert.throws(() => l.check({ browserId: 'b2', actor: 'agentA', role: 'agent', leaseId: b.leaseId }), (e) => e.code === 'LEASE_EXPIRED')
})

function memFs () {
  const files = new Map()
  return { files, append: (n, l) => files.set(n, (files.get(n) || '') + l), read: (n) => files.get(n) || '', list: () => [...files.keys()].sort(), remove: (n) => files.delete(n) }
}

test('audit: hash chain verifies, tamper detected, sensitive params digested', () => {
  const fsApi = memFs()
  const a = createAuditLog({ fsApi, now: () => Date.parse('2025-01-02T00:00:00Z') })
  a.record({ command: 'page.type', actor: { id: 'a' }, paramsDigest: { text: 'TOPSECRET', ref: 'e1' }, outcome: { ok: true } })
  a.record({ command: 'tab.list', actor: { id: 'a' }, outcome: { ok: true } })
  const raw = [...fsApi.files.values()].join('')
  assert.ok(!raw.includes('TOPSECRET'))
  assert.equal(a.verify().ok, true)
  assert.equal(a.verify().count, 2)
  const f = [...fsApi.files.keys()][0]
  fsApi.files.set(f, fsApi.files.get(f).replace('tab.list', 'tab.evil'))
  assert.equal(a.verify().ok, false)
  assert.equal(a.query({ command: 'page.type' }).length, 1)
  const a2 = createAuditLog({ fsApi: memFs() })
  a2.record({ command: 'x' })
  assert.equal(a2.verify().ok, true)
})

test('event bus: seq, collapse, url stripping, redaction, dropped marker', () => {
  const red = createRedactor()
  red.addSecret('s3cretvalue')
  const bus = createEventBus({ redact: (d) => red.redact(d).value, maxEvents: 3 })
  bus.emit('tab.navigated', { tabId: 't_1', data: { url: 'https://a.test/p?token=abc#frag' } })
  bus.emit('tab.title', { tabId: 't_1', data: { title: 'one s3cretvalue' } })
  bus.emit('tab.title', { tabId: 't_1', data: { title: 'two' } })
  let all = bus.since(0)
  assert.equal(all.filter((e) => e.event === 'tab.title').length, 1)
  assert.equal(all[0].data.url, 'https://a.test/p')
  for (let i = 0; i < 5; i++) bus.emit('tab.created', { tabId: 't_' + i, data: { url: 'about:blank' } })
  all = bus.since(0)
  assert.equal(all[0].event, 'events.dropped')
  assert.ok(!JSON.stringify(bus.since(0)).includes('s3cretvalue'))
})

test('confirmations: no approver -> CONFIRMATION_REQUIRED; only local token decides', async () => {
  const c = createConfirmations({ timeoutSec: 5 })
  await assert.rejects(c.request({ command: 'x', summary: 's' }), (e) => e.code === 'CONFIRMATION_REQUIRED')
  c.registerApprover()
  const p = c.request({ command: 'history.list', summary: 's' })
  const id = c.list()[0].confirmationId
  assert.throws(() => c.decide(id, true, 'agent-guess'), (e) => e.code === 'POLICY_DENIED')
  c.decide(id, true, c.localToken())
  assert.equal(await p, true)
  const p2 = c.request({ command: 'x', summary: 's' })
  c.decide(c.list()[0].confirmationId, false, c.localToken())
  await assert.rejects(p2, (e) => e.code === 'CONFIRMATION_REJECTED')
})

