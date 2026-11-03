const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBrowserApi } = require('../../app/lib/browser-api')
const registryJson = require('../../app/lib/browser-api/registry.json')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

const CANARY = 'CANARY-pw-9f3a'

function memFs () {
  const files = new Map()
  return { files, append: (n, l) => files.set(n, (files.get(n) || '') + l), read: (n) => files.get(n) || '', list: () => [...files.keys()].sort(), remove: (n) => files.delete(n) }
}

function build (extra = {}) {
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/', title: 'A' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId }),
    'Page.navigate': () => ({}),
    'Target.createTarget': () => ({ targetId: 'T' + Math.random().toString(36).slice(2, 8) }),
    'Storage.getCookies': { cookies: [{ name: 'sid', value: CANARY, domain: 'a.test', path: '/', secure: true }] },
    'Runtime.evaluate': { result: { value: 'v' } },
    'Accessibility.getFullAXTree': { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }] }
  })
  const fsApi = memFs()
  const api = createBrowserApi({
    launchBrowser: async () => ({ client, userDataDir: 'ud', profileDirectory: 'Default', close () {}, warnings: [] }),
    resolveSourceDir: () => null,
    auditFs: fsApi,
    deviceInfo: () => ({ deviceId: 'dev1', anubisVersion: '5.7.24' }),
    historyReader: { available: false },
    ...extra
  })
  return { api, client, fsApi }
}

let n = 0
const rid = () => 'req_' + String(++n).padStart(8, '0')
const agent = { id: 'agent1', role: 'agent', kind: 'agent' }
const admin = { id: 'admin1', role: 'admin', kind: 'admin' }

async function run (api, command, params, actor = agent, extra = {}) {
  return api.dispatcher.execute({ v: 1, requestId: rid(), command, params, ...extra }, actor)
}

test('every registry command is dispatchable (no UNKNOWN_COMMAND) and examples validate', async () => {
  const { api } = build()
  for (const def of registryJson.commands) {
    assert.ok(api.registry.get(def.name))
  }
  const r = await run(api, 'api.capabilities', {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.result.apiVersion, 1)
  const hist = r.result.commands.find((c) => c.name === 'history.list')
  assert.equal(hist.available, false)
  assert.equal(r.result.commands.find((c) => c.name === 'tab.list').available, true)
})

test('envelope errors: version, unknown command, params, scope', async () => {
  const { api } = build()
  assert.equal((await api.dispatcher.execute({ v: 2, requestId: rid(), command: 'tab.list', browserId: 'b_abcd1234' }, agent)).error.code, 'UNSUPPORTED_VERSION')
  assert.equal((await run(api, 'nope.cmd', {})).error.code, 'UNKNOWN_COMMAND')
  assert.equal((await api.dispatcher.execute({ v: 1, requestId: 'x', command: 'tab.list' }, agent)).error.code, 'INVALID_REQUEST')
  assert.equal((await run(api, 'tab.list', {})).error.code, 'INVALID_REQUEST')
  assert.equal((await run(api, 'tab.list', { bogus: 1 }, agent, { browserId: 'b_abcd1234' })).error.code, 'INVALID_REQUEST')
  assert.equal((await run(api, 'tab.list', {}, agent, { browserId: 'b_abcd1234' })).error.code, 'BROWSER_NOT_FOUND')
})

test('policy: agent dangerous/sensitive commands denied; domain-blocked launch URL denied', async () => {
  const { api } = build()
  const l = await run(api, 'browser.launch', { engine: 'chrome' }, admin)
  assert.equal(l.ok, true, JSON.stringify(l))
  const b = l.result.browserId
  const tabs = (await run(api, 'tab.list', {}, agent, { browserId: b })).result.tabs
  for (const [cmd, params, scope] of [['page.evaluate', { expression: '1' }, { tabId: tabs[0].tabId }], ['cookies.export', {}, { browserId: b }], ['history.clear', {}, { browserId: b }]]) {
    const r = await run(api, cmd, params, agent, scope)
    assert.equal(r.ok, false)
    assert.ok(['POLICY_DENIED', 'CAPABILITY_MISSING'].includes(r.error.code), cmd + ' ' + JSON.stringify(r.error))
  }
  assert.equal((await run(api, 'page.evaluate', { expression: '1' }, agent, { tabId: tabs[0].tabId })).error.code, 'POLICY_DENIED')
  assert.equal((await run(api, 'tab.goto', { url: 'http://127.0.0.1:9/' }, agent, { tabId: tabs[0].tabId })).error.code, 'POLICY_DENIED')
  assert.ok(['POLICY_DENIED', 'INVALID_REQUEST'].includes((await run(api, 'tab.goto', { url: 'file:///c:/secret' }, agent, { tabId: tabs[0].tabId })).error.code))
})

test('agent browser.launch needs confirmation; with no local approver -> CONFIRMATION_REQUIRED and not cached', async () => {
  const { api } = build()
  const id = rid()
  const req = { v: 1, requestId: id, command: 'browser.launch', params: { engine: 'chrome' } }
  assert.equal((await api.dispatcher.execute(req, agent)).error.code, 'CONFIRMATION_REQUIRED')
  api.confirmations.registerApprover()
  const p = api.dispatcher.execute(req, agent)
  await new Promise((r) => setTimeout(r, 10))
  api.confirmations.decide(api.confirmations.list()[0].confirmationId, true, api.confirmations.localToken())
  assert.equal((await p).ok, true)
})

test('idempotency: replayed write returns same response without re-executing; conflict detected', async () => {
  const { api } = build()
  const b = (await run(api, 'browser.launch', { engine: 'chrome' }, admin)).result.browserId
  const id = rid()
  const req = { v: 1, requestId: id, command: 'tab.new', browserId: b, params: { url: 'https://a.test/x' } }
  const first = await api.dispatcher.execute(req, admin)
  const again = await api.dispatcher.execute(req, admin)
  assert.equal(again.replayed, true)
  assert.deepEqual(again.result, first.result)
  const conflict = await api.dispatcher.execute({ ...req, params: { url: 'https://b.test/' } }, admin)
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT')
})

test('leases gate agent writes', async () => {
  const { api } = build()
  const b = (await run(api, 'browser.launch', { engine: 'chrome' }, admin)).result.browserId
  const lease = await run(api, 'lease.acquire', { ttlMs: 5000 }, agent, { browserId: b })
  assert.equal(lease.ok, true, JSON.stringify(lease))
  const other = { id: 'agent2', role: 'agent', kind: 'agent' }
  assert.equal((await run(api, 'tab.new', {}, other, { browserId: b })).error.code, 'BUSY')
  assert.equal((await run(api, 'tab.new', {}, agent, { browserId: b })).error.code, 'LEASE_REQUIRED')
  const last = await run(api, 'tab.new', {}, agent, { browserId: b, leaseId: lease.result.leaseId })
  assert.equal(last.ok, true, JSON.stringify(last))
})

test('dryRun reports the decision without executing', async () => {
  const { api } = build()
  const r = await run(api, 'browser.launch', { engine: 'chrome' }, agent, { dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.result.requiresConfirmation, true)
  assert.equal(api.hub.allBrowsers().length, 0)
})

test('canary: cookie values never reach the agent response, events or audit', async () => {
  const { api, fsApi } = build()
  api.redactor.addSecret(CANARY)
  const b = (await run(api, 'browser.launch', { engine: 'chrome' }, admin)).result.browserId
  const meta = await run(api, 'cookies.export', { mode: 'metadata' }, admin, { browserId: b })
  assert.equal(meta.ok, true)
  assert.equal(meta.result.count, 1)
  const vals = await run(api, 'cookies.export', { mode: 'values' }, admin, { browserId: b })
  assert.ok(!JSON.stringify(vals).includes(CANARY), 'known secret is redacted even in values mode')
  const dump = JSON.stringify(meta) + JSON.stringify(api.events.since(0)) + [...fsApi.files.values()].join('')
  assert.ok(!dump.includes(CANARY))
  assert.equal(api.audit.verify().ok, true)
})

test('snapshot and actions work end-to-end on the fake CDP; audit records every command', async () => {
  const { api, client } = build()
  client.send = ((o) => async (m, p, s) => {
    if (m === 'DOM.getBoxModel') return { model: { content: [0, 0, 4, 0, 4, 4, 0, 4], width: 4, height: 4 } }
    return o(m, p, s)
  })(client.send.bind(client))
  const b = (await run(api, 'browser.launch', { engine: 'chrome' }, admin)).result.browserId
  const t = (await run(api, 'tab.list', {}, agent, { browserId: b })).result.tabs[0].tabId
  const snap = await run(api, 'page.snapshot', {}, agent, { tabId: t })
  assert.equal(snap.ok, true, JSON.stringify(snap))
  assert.equal(snap.result.untrusted, true)
  const click = await run(api, 'page.click', { target: { ref: 'e1', snapshotId: snap.result.snapshotId } }, agent, { tabId: t })
  assert.equal(click.ok, true, JSON.stringify(click))
  const stale = await run(api, 'page.click', { target: { ref: 'e1', snapshotId: 's_999' } }, agent, { tabId: t })
  assert.equal(stale.error.code, 'STALE_REF')
  assert.ok(api.audit.query({ limit: 50 }).length >= 5)
})

test('rate limit and cancel', async () => {
  const { api } = build({ policy: { ...require('../../app/lib/browser-api/policy-engine').DEFAULT_POLICY, limits: { ...require('../../app/lib/browser-api/policy-engine').DEFAULT_POLICY.limits, maxCommandsPerMinute: 2 } } })
  assert.equal((await run(api, 'browser.list', {})).ok, true)
  assert.equal((await run(api, 'browser.list', {})).ok, true)
  assert.equal((await run(api, 'browser.list', {})).error.code, 'RATE_LIMITED')
  assert.equal(api.dispatcher.cancel('nothing', agent), false)
})
