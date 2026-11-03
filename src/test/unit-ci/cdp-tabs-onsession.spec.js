const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTabManager } = require('../../app/lib/cdp-tabs')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function setup (onSession) {
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/', title: 'A' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId })
  })
  let n = 0
  const mgr = createTabManager({ client, idGen: (p) => p + (++n), emit: () => {}, sleep: () => Promise.resolve(), limits: { maxTabsPerBrowser: 3 }, onSession })
  return { mgr, client }
}

test('onSession runs once per tab session, after the domains are enabled', async () => {
  const seen = []
  const { mgr, client } = setup(async (sessionId, tabId) => { seen.push([sessionId, tabId, client.calls.map((c) => c.method).includes('Page.enable')]) })
  const { tabs } = await mgr.init()
  await mgr.send(tabs[0].tabId, 'Runtime.evaluate', {})
  await mgr.send(tabs[0].tabId, 'Runtime.evaluate', {})
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], ['S_T1', tabs[0].tabId, true])
})

test('without onSession nothing extra happens', async () => {
  const { mgr } = setup(undefined)
  const { tabs } = await mgr.init()
  await mgr.send(tabs[0].tabId, 'Runtime.evaluate', {})
})
