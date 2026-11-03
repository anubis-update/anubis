const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createCdpDriver, createRbiDriver, createDriverHub, assertDriver, CAPS } = require('../../app/lib/browser-driver')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function mk (opts = {}) {
  let n = 0
  const launched = []
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/', title: 'A' }] },
    'Storage.getCookies': { cookies: [{ name: 'sid', value: 'SECRETVAL', domain: '.a.test' }, { name: 'o', value: 'x', domain: 'other.test' }] }
  })
  const events = []
  const driver = createCdpDriver({
    launchBrowser: async (o) => { launched.push(o); return { client, userDataDir: 'ud', profileDirectory: 'Default', close () { this.closed = true }, warnings: [] } },
    catalog: opts.catalog,
    historyReader: opts.historyReader,
    getLimits: () => ({ maxBrowsers: 1, maxTabsPerBrowser: 5 }),
    emit: (e, d) => events.push([e, d]),
    idGen: (p) => p + 'abcd' + String(++n).padStart(4, '0')
  })
  return { driver, launched, client, events }
}

test('contract: RBI stub has no capabilities and rejects with NOT_SUPPORTED_BY_ENGINE', async () => {
  const rbi = createRbiDriver()
  assert.equal(rbi.capabilities().size, 0)
  assert.throws(() => rbi.listTabs('b'), (e) => e.code === 'NOT_SUPPORTED_BY_ENGINE')
  assert.throws(() => assertDriver({}), TypeError)
})

test('launch is dedicated by default, enforces limits, rejects extensions/devMode', async () => {
  const { driver, launched } = mk()
  await assert.rejects(driver.launch({ extensions: ['x'] }), (e) => e.code === 'CAPABILITY_MISSING')
  await assert.rejects(driver.launch({ devMode: true }), (e) => e.code === 'CAPABILITY_MISSING')
  const r = await driver.launch({})
  assert.equal(r.profileMode, 'dedicated')
  assert.equal(launched[0].profileMode, 'dedicated')
  assert.equal(launched[0].unsafeExtensionDebugging, undefined)
  await assert.rejects(driver.launch({ profileMode: 'ephemeral' }), (e) => e.code === 'LIMIT_EXCEEDED')
})

test('flags are allowlisted', async () => {
  const { driver, launched } = mk()
  await driver.launch({ flags: ['--lang=en', '--remote-debugging-port=1', '--disable-web-security'] })
  assert.deepEqual(launched[0].extraFlags, ['--lang=en'])
})

test('tabs are listed with browserId, routed by tabId, and closed', async () => {
  const { driver, client } = mk()
  const { browserId } = await driver.launch({})
  const { tabs } = driver.listTabs(browserId)
  assert.equal(tabs[0].browserId, browserId)
  assert.equal(driver.ownsTab(tabs[0].tabId), true)
  const hub = createDriverHub({ drivers: [driver, createRbiDriver()] })
  assert.equal(hub.forTab(tabs[0].tabId), driver)
  assert.equal(hub.forBrowser(browserId), driver)
  assert.throws(() => hub.forBrowser('b_nope'), (e) => e.code === 'BROWSER_NOT_FOUND')
  client.send = ((o) => async (m, p, s) => { const r = await o(m, p, s); if (m === 'Target.closeTarget') client.emit('Target.targetDestroyed', { targetId: p.targetId }); return r })(client.send.bind(client))
  assert.deepEqual(await driver.closeTab(tabs[0].tabId), { closed: true })
  await driver.closeBrowser(browserId)
  assert.equal(driver.listBrowsers().length, 0)
})

test('capabilities: history only when reader available; profiles when catalog', () => {
  assert.ok(!mk().driver.capabilities().has(CAPS.HISTORY))
  const { driver } = mk({ historyReader: { available: true }, catalog: {} })
  assert.ok(driver.capabilities().has(CAPS.HISTORY))
  assert.ok(driver.capabilities().has(CAPS.PROFILES))
})

test('cookies filter by domain', async () => {
  const { driver } = mk()
  const { browserId } = await driver.launch({})
  const all = await driver.cookies(browserId)
  assert.equal(all.length, 2)
  assert.equal((await driver.cookies(browserId, { domains: ['a.test'] })).length, 1)
})

test('profile selection goes through catalog and picks the directory', async () => {
  const catalog = { resolve: (id) => id === 'p_x' ? { engine: 'chrome', dir: 'Profile 1' } : null, selected: () => null, select: (e, id) => id === 'p_x', enumerate: () => ({ profiles: [] }) }
  const { driver, launched } = mk({ catalog })
  await assert.rejects(driver.launch({ profileId: 'p_bad' }), (e) => e.code === 'PROFILE_NOT_FOUND')
  await driver.launch({ profileId: 'p_x', profileMode: 'managed-copy' })
  assert.equal(launched[0].profileDirectory, 'Profile 1')
})
