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
