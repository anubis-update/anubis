const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBrowserApi } = require('../../app/lib/browser-api')
const { createTokenStore } = require('../../app/lib/browser-api/v1-api')
const { createBrowserHubController, EVENT_CHANNEL } = require('../../app/lib/browser-api/hub-controller')

function mk () {
  const sent = []
  const memFs = { mkdirSync () {}, appendFileSync () {}, readdirSync: () => [], unlinkSync () {}, existsSync: () => false, writeFileSync () {}, statSync: () => ({ size: 0 }) }
  let disk
  const api = createBrowserApi({
    launchBrowser: async () => { throw new Error('not used') },
    auditFs: memFs,
    auditDir: 'C:\\audit',
    policyIo: { read: () => disk, write: (d) => { disk = d } },
    engines: ['chrome']
  })
  const tokens = createTokenStore()
  const ctl = createBrowserHubController({ api, tokens, send: (c, e) => sent.push([c, e]) })
  return { api, tokens, ctl, sent, getDisk: () => disk }
}

test('unknown actions and bad payloads return ok:false without throwing', async () => {
  const { ctl } = mk()
  assert.deepEqual(await ctl.handle('nope', {}), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown browserHub action' } })
  assert.equal((await ctl.handle('toString', {})).ok, false)
  const r = await ctl.handle('tokens.issue', { role: 'admin' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'INVALID_REQUEST')
  assert.equal((await ctl.handle('tokens.issue', { ttlSec: 5 })).ok, false)
  assert.equal((await ctl.handle('policy.set', null)).ok, false)
})

test('status reports engines, default-deny installs and no approver', async () => {
  const { ctl } = mk()
  const { result } = await ctl.handle('status')
  assert.deepEqual(result.engines.map((e) => e.engine), ['chrome'])
  assert.equal(result.allowExtensionInstall, false)
  assert.equal(result.approverRegistered, false)
  assert.ok(result.engines[0].capabilities.includes('extensions'))
})

test('tokens: issue returns the secret once, list/revoke never expose it', async () => {
  const { ctl, tokens } = mk()
  const issued = (await ctl.handle('tokens.issue', { role: 'agent', ttlSec: 3600, label: 'ci' })).result
  assert.match(issued.token, /^abt_/)
  assert.equal(issued.info.label, 'ci')
  assert.ok(tokens.verify(issued.token))
  const listed = (await ctl.handle('tokens.list')).result.tokens
  assert.equal(JSON.stringify(listed).includes(issued.token), false)
  assert.equal((await ctl.handle('tokens.revoke', { id: issued.info.id })).result.revoked, true)
  assert.equal(tokens.verify(issued.token), null)
  assert.equal((await ctl.handle('tokens.revoke', { id: 'tok_none' })).result.revoked, false)
})

test('policy.set validates, applies live and persists; allowExtensionInstall follows', async () => {
  const { ctl, getDisk } = mk()
  const doc = (await ctl.handle('policy.get')).result.policy
  const next = JSON.parse(JSON.stringify(doc))
  next.extensions = { allowInstall: true }
  assert.equal((await ctl.handle('policy.set', { policy: next })).ok, true)
  assert.equal(getDisk().extensions.allowInstall, true)
  assert.equal((await ctl.handle('status')).result.allowExtensionInstall, true)
  const bad = await ctl.handle('policy.set', { policy: { version: 3 } })
  assert.equal(bad.error.code, 'INVALID_REQUEST')
  assert.equal((await ctl.handle('policy.reset')).ok, true)
  assert.equal((await ctl.handle('status')).result.allowExtensionInstall, false)
})

test('confirmations: needs a registered approver; decide uses the hidden local token', async () => {
  const { ctl, api } = mk()
  const a = await ctl.handle('approver.register')
  assert.equal(a.result.registered, true)
  assert.equal((await ctl.handle('status')).result.approverRegistered, true)
  const pending = api.confirmations.request({ command: 'devMode.set', summary: 'x' })
  const items = (await ctl.handle('confirmations.list')).result.items
  assert.equal(items.length, 1)
  assert.equal(JSON.stringify(items).includes(api.confirmations.localToken()), false)
  const d = await ctl.handle('confirmations.decide', { confirmationId: items[0].confirmationId, approve: true })
  assert.deepEqual(d.result, { decided: true })
  await pending
  assert.equal((await ctl.handle('confirmations.decide', { confirmationId: 'zzz', approve: true })).ok, false)
  assert.equal((await ctl.handle('confirmations.decide', { confirmationId: 'zzz' })).error.code, 'INVALID_REQUEST')
  await ctl.handle('approver.unregister')
  assert.equal((await ctl.handle('status')).result.approverRegistered, false)
  ctl.dispose()
})

test('events are pushed on the browserHub:event channel once subscribed', async () => {
  const { ctl, api, sent } = mk()
  api.events.emit('browser.launched', { browserId: 'b1', data: { engine: 'chrome' } })
  assert.equal(sent.length, 0)
  await ctl.handle('events.subscribe')
  api.events.emit('browser.closed', { browserId: 'b1', data: {} })
  assert.equal(sent[0][0], EVENT_CHANNEL)
  assert.equal(sent[0][1].event, 'browser.closed')
  assert.equal((await ctl.handle('events.since', { seq: 0 })).result.events.length, 2)
  await ctl.handle('events.unsubscribe')
  api.events.emit('browser.closed', {})
  assert.equal(sent.length, 1)
})

test('command.execute runs as UI admin; evaluate/cookies/passwords are blocked', async () => {
  const { ctl } = mk()
  const r = await ctl.handle('command.execute', { command: 'browser.list', params: {} })
  assert.equal(r.ok, true)
  assert.equal(r.result.ok, true)
  assert.deepEqual(r.result.result.browsers, [])
  for (const c of ['page.evaluate', 'cookies.export', 'passwords.export']) {
    assert.equal((await ctl.handle('command.execute', { command: c, params: {} })).error.code, 'POLICY_DENIED')
  }
  const inst = await ctl.handle('command.execute', { command: 'extension.install', params: { source: { type: 'unpacked', stagedId: 'x' } }, browserId: 'b_none' })
  assert.equal(inst.ok, true)
  assert.equal(inst.result.ok, false)
})

test('staging.import without staging is CAPABILITY_MISSING', async () => {
  const { ctl } = mk()
  assert.equal((await ctl.handle('staging.import', { path: 'C:\\x' })).error.code, 'CAPABILITY_MISSING')
})
