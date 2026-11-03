const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const hub = require('../../client/components/web/hub-client')
const policy = require('../../client/components/web/hub-policy')

beforeEach(() => { hub.setTransport(null); hub.resetMock() })

test('mock mode by default; transport overrides', async () => {
  assert.equal(hub.isMock(), true)
  hub.setTransport(async (c, p) => ({ c, p }))
  assert.equal(hub.isMock(), false)
  assert.deepEqual(await hub.call('tab.list', { a: 1 }), { c: 'tab.list', p: { a: 1 } })
})

test('profiles select and tabs lifecycle', async () => {
  await hub.call('profile.select', { profileId: 'prof_work' })
  assert.equal((await hub.call('profile.list')).selected, 'prof_work')
  await assert.rejects(hub.call('profile.select', { profileId: 'x' }), { code: 'NOT_FOUND' })
  const t = await hub.call('tab.new', { url: 'https://a.b' })
  assert.equal((await hub.call('tab.list')).activeTabId, t.tabId)
  await hub.call('tab.close', { tabId: t.tabId })
  assert.equal((await hub.call('tab.list')).tabs.length, 1)
})

test('extensions install/enable/disable/remove and devMode', async () => {
  const e = await hub.call('extension.install', { path: 'C:\\x\\myext' })
  assert.equal(e.name, 'myext')
  await hub.call('extension.enable', { extensionId: e.extensionId })
  assert.equal((await hub.call('extension.list')).extensions[0].enabled, true)
  await hub.call('extension.remove', { extensionId: e.extensionId })
  assert.equal((await hub.call('extension.list')).extensions.length, 0)
  assert.equal((await hub.call('devMode.set', { enabled: true })).devMode, true)
})

test('history search and tokens', async () => {
  assert.equal((await hub.call('history.search', { query: 'EXAMPLE' })).items.length, 1)
  assert.equal((await hub.call('history.search', { query: 'zzz' })).items.length, 0)
  const tok = await hub.call('api.token.create', { label: 'a' })
  assert.ok(tok.token.startsWith('anb_'))
  assert.equal((await hub.call('api.token.list')).tokens[0].token, undefined)
  await hub.call('api.token.revoke', { tokenId: tok.tokenId })
  assert.equal((await hub.call('api.token.list')).tokens.length, 0)
  assert.ok((await hub.call('api.audit.list')).entries.length > 0)
})

test('policy: default deny, validation, setRule', async () => {
  const { policy: p } = await hub.call('api.policy.get')
  assert.deepEqual(policy.validatePolicy(p), [])
  assert.equal(policy.effectFor(p, 'agent', 'passwords.export'), 'deny')
  assert.equal(policy.effectFor(p, 'agent', 'unknown.cmd'), 'deny')
  const p2 = policy.setRule(p, 'agent', 'tab.new', 'confirm')
  assert.equal(policy.effectFor(p2, 'agent', 'tab.new'), 'confirm')
  assert.ok(policy.validatePolicy(policy.setRule(p, 'agent', '*', 'allow')).length)
  assert.ok(policy.validatePolicy({ defaultEffect: 'allow', roles: {} }).length)
  assert.equal(policy.isDangerous('passwords.export'), true)
  assert.equal(policy.isDangerous('tab.new'), false)
})
