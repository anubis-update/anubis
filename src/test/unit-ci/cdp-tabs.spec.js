const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTabManager } = require('../../app/lib/cdp-tabs')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function setup (extra = {}) {
  let n = 0
  const events = []
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/x', title: 'A' }, { type: 'service_worker', targetId: 'SW' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId }),
    'Target.createTarget': () => ({ targetId: 'T2' }),
    'Page.navigate': () => ({}),
    ...extra
  })
  const mgr = createTabManager({
    client,
    idGen: (p) => p + (++n),
    emit: (e, d) => events.push([e, d]),
    sleep: () => Promise.resolve(),
    limits: { maxTabsPerBrowser: 2 }
  })
  return { client, mgr, events }
}

test('init lists page targets only', async () => {
  const { mgr } = setup()
  const r = await mgr.init()
  assert.equal(r.tabs.length, 1)
  assert.equal(r.tabs[0].url, 'https://a.test/x')
  assert.equal(r.activeTabId, r.tabs[0].tabId)
})

test('newTab enforces limit and marks agent-created', async () => {
  const { mgr, client, events } = setup()
  await mgr.init()
  const r = await mgr.newTab({ url: 'https://b.test' })
  assert.ok(r.tab.tabId)
  assert.ok(events.some(e => e[0] === 'tab.created' && e[1].data.byAgent === true))
  assert.equal(mgr.count(), 2)
  await assert.rejects(mgr.newTab({}), (e) => e.code === 'LIMIT_EXCEEDED')
})

test('popup gets openerTabId and byAgent false', async () => {
  const { mgr, client, events } = setup()
  const { tabs } = await mgr.init()
  client.emit('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'P', openerId: 'T1', url: 'about:blank' } })
  const ev = events.filter(e => e[0] === 'tab.created').pop()
  assert.equal(ev[1].data.openerTabId, tabs[0].tabId)
  assert.equal(ev[1].data.byAgent, false)
})

test('goto attaches flattened session and waits for load', async () => {
  const { mgr, client } = setup()
  const { tabs } = await mgr.init()
  const p = mgr.goto(tabs[0].tabId, 'https://c.test/', { waitUntil: 'load', timeoutMs: 500 })
  await new Promise(r => setTimeout(r, 20))
  client.emit('Page.loadEventFired', {}, 'S_T1')
  const res = await p
  assert.equal(res.loaded, true)
  const attach = client.calls.find(c => c.method === 'Target.attachToTarget')
  assert.equal(attach.params.flatten, true)
})

test('goto times out and unknown tab errors', async () => {
  const { mgr } = setup()
  const { tabs } = await mgr.init()
  await assert.rejects(mgr.goto(tabs[0].tabId, 'https://c.test/', { timeoutMs: 20 }), (e) => e.code === 'TIMEOUT')
  await assert.rejects(mgr.goto('t_nope', 'https://c.test/'), (e) => e.code === 'TAB_NOT_FOUND')
})

test('close removes tab; second close is idempotent', async () => {
  const { mgr, client } = setup()
  const { tabs } = await mgr.init()
  client.send = ((orig) => async (m, p, s) => {
    const r = await orig(m, p, s)
    if (m === 'Target.closeTarget') client.emit('Target.targetDestroyed', { targetId: p.targetId })
    return r
  })(client.send.bind(client))
  assert.deepEqual(await mgr.close(tabs[0].tabId), { closed: true })
  assert.deepEqual(await mgr.close(tabs[0].tabId), { closed: false })
})

test('dialogs are auto-handled', async () => {
  const { mgr, client, events } = setup()
  const { tabs } = await mgr.init()
  await mgr.ensureSession(tabs[0].tabId)
  client.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' }, 'S_T1')
  assert.ok(client.calls.some(c => c.method === 'Page.handleJavaScriptDialog'))
  assert.ok(events.some(e => e[0] === 'page.dialog'))
})
