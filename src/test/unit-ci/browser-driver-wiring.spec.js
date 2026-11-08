const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createCdpDriver, CAPS } = require('../../app/lib/browser-driver')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function mk (extra = {}) {
  const launched = []
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/', title: 'A' }] }
  })
  const made = { guards: [], extMgrs: [], sessionHooks: [] }
  const driver = createCdpDriver({
    launchBrowser: async (o) => { launched.push(o); return { client, userDataDir: 'ud', close () {}, warnings: [] } },
    getLimits: () => ({ maxBrowsers: 2, maxTabsPerBrowser: 5 }),
    idGen: (p) => p + 'abcd0001',
    makeNavGuard: (o) => { const g = { o, attached: [], attach: async (s, t) => { g.attached.push([s, t]) } }; made.guards.push(g); return g },
    makeTabs: (o) => {
      made.sessionHooks.push(o.onSession)
      return { init: async () => {}, dispose () {}, count: () => 0, has: () => true, info: () => ({ url: 'https://a.test/' }), send: async () => ({}), newTab: async () => ({ tab: { tabId: 't1' } }), close: async () => ({}) }
    },
    makePage: () => ({ forget () {} }),
    makeDownloads: () => ({ start: async () => { made.dlStarted = true }, list: (o) => ({ items: [], echo: o }) }),
    makeStorage: ({ tabs }) => ({ tag: 'storage', tabs }),
    makeExtensions: (o) => { const m = { o, tag: 'ext' }; made.extMgrs.push(m); return m },
    makeHistoryClearer: ({ engine }) => async (o) => ({ cleared: true, engine, o }),
    ...extra
  })
  return { driver, launched, client, made }
}

test('new capabilities are advertised', () => {
  const caps = mk().driver.capabilities()
  for (const c of [CAPS.EXTENSIONS, CAPS.EXTENSIONS_LOAD, CAPS.DEV_MODE, CAPS.STORAGE, CAPS.DOWNLOADS, CAPS.UPLOAD]) assert.ok(caps.has(c), c)
  assert.ok(!caps.has('passwords.ui'))
})

test('engine-independent commands work when only Edge or RBI is configured', async () => {
  const { createBrowserApi } = require('../../app/lib/browser-api')
  for (const engines of [['edge'], []]) {
    const api = createBrowserApi({
      engines,
      launchBrowser: async () => { throw new Error('Capabilities must not launch a browser') },
      resolveSourceDir: () => null,
      auditFs: { append () {}, read: () => '', list: () => [] }
    })
    try {
      const response = await api.dispatcher.execute({
        v: 1, requestId: 'capabilities_single_engine', command: 'api.capabilities', params: {}
      }, { id: 'test', role: 'agent', kind: 'remote' })
      assert.equal(response.ok, true, JSON.stringify(response.error))
      assert.equal(response.result.engines[0].engine, engines[0] || 'rbi')
    } finally { api.shutdown() }
  }
})

test('nav guard is wired only with checkUrl and bound through onSession', async () => {
  const a = mk({ checkUrl: () => ({ ok: true }) })
  await a.driver.launch({})
  assert.equal(a.made.guards.length, 1)
  await a.made.sessionHooks[0]('S1', 'T1')
  assert.deepEqual(a.made.guards[0].attached, [['S1', 'T1']])
  const b = mk()
  await b.driver.launch({})
  assert.equal(b.made.guards.length, 0)
  assert.equal(b.made.sessionHooks[0], undefined)
})

test('downloads tracking starts on launch; unsafe extension debugging follows policy', async () => {
  const a = mk({ allowExtensions: () => true })
  const r = await a.driver.launch({})
  assert.equal(a.made.dlStarted, true)
  assert.equal(a.launched[0].unsafeExtensionDebugging, true)
  assert.deepEqual(a.driver.downloads(r.browserId, { limit: 5 }).echo, { limit: 5 })
  assert.equal(mk().driver.launch({}) instanceof Promise, true)
})

test('extension manager is created lazily once per browser with injected sources', async () => {
  const resolveSource = () => 'C:\\x'
  const readDevModePolicy = () => 'allow'
  const a = mk({ resolveSource, readDevModePolicy })
  const r = await a.driver.launch({})
  const m1 = a.driver.extensionsOf(r.browserId)
  assert.equal(m1, a.driver.extensionsOf(r.browserId))
  assert.equal(a.made.extMgrs.length, 1)
  assert.equal(m1.o.resolveSource, resolveSource)
  assert.equal(m1.o.readDevModePolicy, readDevModePolicy)
  assert.equal(m1.o.engine, 'chrome')
  assert.throws(() => a.driver.extensionsOf('nope'), (e) => e.code === 'BROWSER_NOT_FOUND')
})

test('storage and clearHistory use the owning browser', async () => {
  const a = mk()
  const r = await a.driver.launch({})
  assert.equal(a.driver.storage('t1').tag, 'storage')
  assert.deepEqual(await a.driver.clearHistory(r.browserId, { since: 5 }), { cleared: true, engine: 'chrome', o: { since: 5 } })
  await assert.rejects(async () => a.driver.downloads('nope'), (e) => e.code === 'BROWSER_NOT_FOUND')
})

test('shared launch settings read persisted profile and current install policy without exposing paths', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'anubis-shared-options-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { profileIdFor } = require('../../app/lib/cdp-profiles')
  const { createBrowserApi } = require('../../app/lib/browser-api')
  const { DEFAULT_POLICY } = require('../../app/lib/browser-api/policy-engine')
  const profileId = profileIdFor('chrome', 'Profile 2')
  const api = createBrowserApi({
    launchBrowser: async () => { throw new Error('Must not launch') },
    auditDir: root,
    resolveSourceDir: () => 'source',
    catalogIo: {
      exists: () => true,
      readFile: () => JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work' } } } }),
      persist: { read: () => ({ chrome: profileId }), write () {} }
    }
  })
  t.after(() => api.shutdown())
  assert.deepEqual(api.sharedLaunchOptions('chrome'), {
    profileId, profileDirectory: 'Profile 2', unsafeExtensionDebugging: false
  })
  api.policy.setPolicy({ ...DEFAULT_POLICY, extensions: { allowInstall: true } })
  assert.equal(api.sharedLaunchOptions('chrome').unsafeExtensionDebugging, true)
  assert.deepEqual(api.sharedLaunchOptions('edge'), { unsafeExtensionDebugging: true })
})

test('saved extension restoration runs only with explicit install permission', async () => {
  for (const allowed of [false, true]) {
    let restored = 0
    const store = { read: () => [], write () {} }
    const a = mk({
      allowExtensions: () => allowed,
      extensionStateForHandle: () => store,
      makeExtensions: options => {
        assert.equal(options.extensionState, store)
        return { restore: async () => { restored++ } }
      }
    })
    await a.driver.launch({})
    assert.equal(restored, allowed ? 1 : 0)
    a.driver.shutdown()
  }
})
