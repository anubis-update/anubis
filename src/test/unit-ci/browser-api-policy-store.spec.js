const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPolicyEngine, DEFAULT_POLICY } = require('../../app/lib/browser-api/policy-engine')
const { createPolicyStore, sanitize } = require('../../app/lib/browser-api/policy-store')

const clone = (o) => JSON.parse(JSON.stringify(o))

test('default policy denies extension installs; admin overlay cannot enable them', () => {
  const e = createPolicyEngine({ policy: DEFAULT_POLICY })
  assert.equal(e.extensions().allowInstall, false)
  const open = clone(DEFAULT_POLICY)
  open.extensions.allowInstall = true
  assert.equal(createPolicyEngine({ policy: open }).extensions().allowInstall, true)
  assert.equal(createPolicyEngine({ policy: open, adminOverlay: { extensions: { allowInstall: false } } }).extensions().allowInstall, false)
  assert.equal(createPolicyEngine({ policy: DEFAULT_POLICY, adminOverlay: { extensions: { allowInstall: true } } }).extensions().allowInstall, false)
})

test('set sanitises, applies and persists; get returns snapshot without mutating defaults', () => {
  const e = createPolicyEngine({ policy: DEFAULT_POLICY })
  let disk
  const store = createPolicyStore({ engine: e, io: { read: () => disk, write: (d) => { disk = d } } })
  const doc = clone(DEFAULT_POLICY)
  doc.limits.maxBrowsers = 5
  doc.extensions.allowInstall = true
  doc.evil = { x: 1 }
  doc.roles.agent.rules.unshift({ command: 'tab.close', effect: 'deny', junk: 1 })
  const r = store.set(doc)
  assert.equal(r.policy.limits.maxBrowsers, 5)
  assert.equal(e.limits().maxBrowsers, 5)
  assert.equal(e.extensions().allowInstall, true)
  assert.equal(disk.evil, undefined)
  assert.equal(disk.roles.agent.rules[0].junk, undefined)
  assert.equal(e.evaluate({ role: 'agent', command: 'tab.close' }).effect, 'deny')
  assert.equal(createPolicyStore({ engine: e, io: { read: () => disk } }).load().limits.maxBrowsers, 5)
  assert.equal(store.get().defaults.limits.maxBrowsers, 2)
  store.reset()
  assert.equal(disk, null)
  assert.equal(e.limits().maxBrowsers, 2)
})

test('invalid documents are rejected and nothing is applied or written', () => {
  const e = createPolicyEngine({ policy: DEFAULT_POLICY })
  let wrote = false
  const store = createPolicyStore({ engine: e, io: { write: () => { wrote = true } } })
  const mut = (fn) => { const d = clone(DEFAULT_POLICY); fn(d); return d }
  const cases = [
    null,
    mut((d) => { d.version = 2 }),
    mut((d) => { d.defaultEffect = 'maybe' }),
    mut((d) => { delete d.roles.agent }),
    mut((d) => { d.roles.agent.rules.push({ command: 'rm -rf', effect: 'allow' }) }),
    mut((d) => { d.roles.agent.rules.push({ command: 'tab.*', effect: 'yes' }) }),
    mut((d) => { d.limits.maxBrowsers = 9999 }),
    mut((d) => { d.limits.maxTabsPerBrowser = '5' }),
    mut((d) => { d.domains.deny = ['a b'] }),
    mut((d) => { d.redaction.maskPatterns = ['(unclosed'] }),
    mut((d) => { d.confirmation.timeoutSec = 1 })
  ]
  for (const c of cases) assert.throws(() => store.set(c), (x) => x.code === 'INVALID_REQUEST')
  assert.equal(wrote, false)
  assert.equal(e.limits().maxBrowsers, 2)
})

test('sanitize keeps blocked schemes and forces local-ui confirmations', () => {
  const d = clone(DEFAULT_POLICY)
  d.domains.blockSchemes = []
  d.confirmation.channel = 'remote'
  d.confirmation.rememberMinutes = 999
  const s = sanitize(d)
  assert.ok(s.domains.blockSchemes.includes('file'))
  assert.equal(s.confirmation.channel, 'local-ui')
  assert.equal(s.confirmation.rememberMinutes, 0)
  assert.equal(s.redaction.maskPasswordFields, true)
})

test('load returns null for missing or corrupt documents', () => {
  const e = createPolicyEngine({ policy: DEFAULT_POLICY })
  assert.equal(createPolicyStore({ engine: e, io: { read: () => null } }).load(), null)
  assert.equal(createPolicyStore({ engine: e, io: { read: () => ({ version: 9 }) } }).load(), null)
  assert.equal(createPolicyStore({ engine: e, io: { read: () => { throw new Error('x') } } }).load(), null)
})
