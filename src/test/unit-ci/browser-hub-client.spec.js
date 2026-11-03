const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const hub = require('../../client/components/web/hub-client')
const policy = require('../../client/components/web/hub-policy')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')
const registry = require('../../app/lib/browser-api/registry.json')

beforeEach(() => { hub.setMock(false); hub.resetMock() })
afterEach(() => { delete global.window })

function installPre (handler) {
  const calls = []
  const listeners = {}
  global.window = {
    pre: {
      runGlobalAsync: async (name, action, payload) => {
        calls.push({ name, action, payload })
        return handler(action, payload)
      },
      ipcOnEvent: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb) },
      ipcOffEvent: (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter(x => x !== cb) }
    }
  }
  return { calls, listeners }
}

test('mock mode only when window.pre is absent', async () => {
  assert.equal(hub.isMock(), true)
  installPre(() => ({ ok: true, result: {} }))
  assert.equal(hub.isMock(), false)
})

test('real transport: runGlobalAsync("browserHub", action, payload) and unwrap', async () => {
  const { calls } = installPre((action) => action === 'tokens.revoke'
    ? { ok: true, result: { revoked: true } }
    : { ok: false, error: { code: 'DISABLED', message: 'off' } })
  assert.deepEqual(await hub.tokensRevoke('t1'), { revoked: true })
  assert.deepEqual(calls[0], { name: 'browserHub', action: 'tokens.revoke', payload: { id: 't1' } })
  await assert.rejects(hub.status(), { code: 'DISABLED', message: 'off' })
})

test('exec wraps command.execute and unwraps the dispatcher envelope', async () => {
  const { calls } = installPre((action, p) => ({
    ok: true,
    result: p.command === 'tab.close'
      ? { v: 1, ok: false, error: { code: 'TAB_NOT_FOUND', message: 'gone' } }
      : { v: 1, ok: true, result: { tabs: [] } }
  }))
  assert.deepEqual(await hub.exec('tab.list', {}, { browserId: 'b1' }), { tabs: [] })
  assert.deepEqual(calls[0].payload, { command: 'tab.list', params: {}, browserId: 'b1' })
  await assert.rejects(hub.exec('tab.close', {}, { browserId: 'b1', tabId: 't9' }), { code: 'TAB_NOT_FOUND' })
  assert.deepEqual(calls[1].payload, { command: 'tab.close', params: {}, browserId: 'b1', tabId: 't9' })
})

test('onEvent subscribes to browserHub:event and unsubscribes', () => {
  const { listeners } = installPre(() => ({ ok: true, result: {} }))
  const got = []
  const off = hub.onEvent(ev => got.push(ev))
  assert.equal(listeners['browserHub:event'].length, 1)
  listeners['browserHub:event'][0]({}, { event: 'tab.created', seq: 1 })
  assert.deepEqual(got, [{ event: 'tab.created', seq: 1 }])
  off()
  assert.equal(listeners['browserHub:event'].length, 0)
})

test('mock: profiles, tabs, extensions via real shapes', async () => {
  const b = { browserId: 'br_1' }
  assert.equal((await hub.exec('profile.list')).profiles.length, 2)
  assert.equal((await hub.exec('profile.select', { profileId: 'prof_work' })).selected.profileId, 'prof_work')
  await assert.rejects(hub.exec('profile.select', { profileId: 'x' }), { code: 'PROFILE_NOT_FOUND' })
  const { tab } = await hub.exec('tab.new', { url: 'https://a.b' }, b)
  assert.equal((await hub.exec('tab.list', {}, b)).activeTabId, tab.tabId)
  await hub.exec('tab.close', {}, { ...b, tabId: tab.tabId })
  assert.equal((await hub.exec('tab.list', {}, b)).tabs.length, 1)

  const staged = await hub.stagingImport('C:\\x\\myext')
  await assert.rejects(hub.exec('extension.install', { source: { type: 'unpacked', stagedId: staged.stagedId } }, b), { code: 'POLICY_DENIED' })
  const pol = (await hub.policyGet()).policy
  await hub.policySet({ ...pol, extensions: { allowInstall: true } })
  const { extension: e } = await hub.exec('extension.install', { source: { type: 'unpacked', stagedId: staged.stagedId } }, b)
  assert.equal(e.name, 'myext')
  await hub.exec('extension.enable', { extensionId: e.extensionId }, b)
  assert.equal((await hub.exec('extension.list', {}, b)).extensions[0].enabled, true)
  await hub.exec('extension.remove', { extensionId: e.extensionId }, b)
  assert.equal((await hub.exec('extension.list', {}, b)).extensions.length, 0)
  assert.equal((await hub.exec('devMode.set', { enabled: true }, b)).enabled, true)
})

test('mock: UI-blocked commands, history, tokens', async () => {
  await assert.rejects(hub.exec('cookies.export', {}, { browserId: 'br_1' }), { code: 'POLICY_DENIED' })
  assert.equal((await hub.exec('history.search', { query: 'EXAMPLE' })).items.length, 1)
  assert.equal((await hub.exec('history.search', { query: 'zzz' })).items.length, 0)
  assert.equal((await hub.exec('history.clear')).cleared, true)
  const { token, info } = await hub.tokensIssue({ label: 'a' })
  assert.ok(token.startsWith('abt_'))
  assert.equal((await hub.tokensList()).tokens[0].token, undefined)
  assert.equal((await hub.tokensRevoke(info.id)).revoked, true)
  assert.equal((await hub.tokensList()).tokens.length, 0)
  await assert.rejects(hub.tokensIssue({ role: 'admin' }), { code: 'INVALID_REQUEST' })
})

test('contract: every action/command used by the Browser Hub exists in the real backend', () => {
  const actions = createBrowserHubController({ api: {}, tokens: {} }).actions()
  const used = ['status', 'policy.get', 'policy.set', 'policy.reset', 'tokens.list', 'tokens.issue', 'tokens.revoke',
    'confirmations.list', 'confirmations.decide', 'approver.register', 'approver.unregister', 'staging.import', 'command.execute']
  used.forEach(a => assert.ok(actions.includes(a), 'missing action ' + a))
  const names = registry.commands.map(c => c.name)
  const cmds = ['browser.launch', 'browser.close', 'profile.list', 'profile.select', 'tab.list', 'tab.new', 'tab.activate', 'tab.close',
    'extension.list', 'extension.install', 'extension.enable', 'extension.disable', 'extension.remove', 'devMode.set',
    'history.list', 'history.search', 'history.clear']
  cmds.forEach(c => assert.ok(names.includes(c), 'missing command ' + c))
  assert.ok(!cmds.some(c => /^(cookies|passwords)\./.test(c)))
})

test('policy: validation, glob matching, setRule', async () => {
  const { policy: p } = await hub.policyGet()
  assert.deepEqual(policy.validatePolicy(p), [])
  assert.equal(policy.effectFor(p, 'agent', 'passwords.export'), 'deny')
  assert.equal(policy.effectFor(p, 'agent', 'tab.new'), 'allow')
  assert.equal(policy.effectFor(p, 'agent', 'unknown.cmd'), 'allow')
  assert.equal(policy.effectFor({ roles: {} }, 'agent', 'tab.new'), 'deny')
  const p2 = policy.setRule(p, 'agent', 'tab.new', 'confirm')
  assert.equal(policy.effectFor(p2, 'agent', 'tab.new'), 'confirm')
  assert.ok(policy.validatePolicy({ defaultEffect: 'allow', roles: {} }).length)
  assert.ok(policy.validatePolicy({ defaultEffect: 'deny', roles: { agent: { rules: [{ command: 'x', effect: 'maybe' }] } } }).length)
  assert.equal(policy.isDangerous('passwords.export'), true)
  assert.equal(policy.isDangerous('tab.new'), false)
})
