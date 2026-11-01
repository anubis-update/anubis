const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRbiRpcRouter, engineNameFor } = require('../../app/lib/rbi-rpc-router')

function fakeEngine (label) {
  const calls = []
  const make = (method) => (arg) => { calls.push({ method, arg }); return Promise.resolve({ label, method }) }
  return {
    label,
    calls,
    open: make('open'),
    input: make('input'),
    nav: make('nav'),
    resize: make('resize'),
    close: make('close'),
    exportCookies: make('exportCookies'),
    importCookies: make('importCookies')
  }
}

function fixture ({ cdp = fakeEngine('cdp'), rbi = fakeEngine('rbi') } = {}) {
  const router = createRbiRpcRouter({
    getRbiBrowser: () => rbi,
    getCdpBrowser: () => cdp
  })
  return { router, rbi, cdp }
}

test('engineNameFor maps chrome/edge to cdp and everything else to rbi', () => {
  assert.equal(engineNameFor('chrome'), 'cdp')
  assert.equal(engineNameFor('edge'), 'cdp')
  assert.equal(engineNameFor('rbi'), 'rbi')
  assert.equal(engineNameFor(undefined), 'rbi')
  assert.equal(engineNameFor('something'), 'rbi')
})

test('router requires getRbiBrowser', () => {
  assert.throws(() => createRbiRpcRouter({}), /getRbiBrowser/)
})

test('handles only the rbi* control functions', () => {
  const { router } = fixture()
  for (const func of ['rbiOpen', 'rbiInput', 'rbiNav', 'rbiResize', 'rbiClose', 'rbiExportCookies', 'rbiImportCookies']) {
    assert.equal(router.handles(func), true)
  }
  assert.equal(router.handles('managedMcpEndpoint'), false)
  assert.equal(router.handles('restart'), false)
})

test('rbiOpen without an engine defaults to the RBI engine', async () => {
  const { router, rbi, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com' }])
  assert.equal(rbi.calls.length, 1)
  assert.equal(cdp.calls.length, 0)
})

test('rbiOpen with engine chrome routes to the CDP engine', async () => {
  const { router, rbi, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com', engine: 'chrome' }])
  assert.equal(cdp.calls.length, 1)
  assert.equal(rbi.calls.length, 0)
  assert.equal(cdp.calls[0].method, 'open')
})

test('rbiOpen with engine edge routes to the CDP engine', async () => {
  const { router, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com', engine: 'edge' }])
  assert.equal(cdp.calls.length, 1)
})

test('subsequent calls follow the engine that owns the id', async () => {
  const { router, rbi, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'chr', url: 'https://a.com', engine: 'chrome' }])
  await router.dispatch('rbiOpen', [{ id: 'int', url: 'https://b.com' }])
  await router.dispatch('rbiInput', [{ id: 'chr', t: 'mouse', kind: 'down' }])
  await router.dispatch('rbiNav', [{ id: 'int', action: 'reload' }])
  await router.dispatch('rbiResize', [{ id: 'chr', width: 10, height: 20 }])
  assert.deepEqual(cdp.calls.map(c => c.method), ['open', 'input', 'resize'])
  assert.deepEqual(rbi.calls.map(c => c.method), ['open', 'nav'])
})

test('cookie calls route to the owning engine', async () => {
  const { router, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'chr', url: 'https://a.com', engine: 'chrome' }])
  await router.dispatch('rbiExportCookies', [{ id: 'chr' }])
  await router.dispatch('rbiImportCookies', [{ id: 'chr', cookies: [] }])
  assert.deepEqual(cdp.calls.map(c => c.method), ['open', 'exportCookies', 'importCookies'])
})

test('rbiClose dispatches to the owner and forgets the id', async () => {
  const { router, rbi, cdp } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'chr', url: 'https://a.com', engine: 'chrome' }])
  await router.dispatch('rbiClose', [{ id: 'chr' }])
  assert.equal(cdp.calls.at(-1).method, 'close')
  assert.equal(router._owners.has('chr'), false)
  // after close the id is unknown, so a stray call defaults back to rbi
  await router.dispatch('rbiInput', [{ id: 'chr', t: 'mouse', kind: 'move' }])
  assert.equal(rbi.calls.at(-1).method, 'input')
})

test('a reused id can switch engines on the next open', async () => {
  const { router, rbi } = fixture()
  await router.dispatch('rbiOpen', [{ id: 'x', url: 'https://a.com', engine: 'chrome' }])
  await router.dispatch('rbiOpen', [{ id: 'x', url: 'https://b.com', engine: 'rbi' }])
  await router.dispatch('rbiInput', [{ id: 'x', t: 'key', kind: 'down' }])
  assert.equal(rbi.calls.at(-1).method, 'input')
})

test('routing to a not-ready CDP engine throws a clear error', async () => {
  const router = createRbiRpcRouter({
    getRbiBrowser: () => fakeEngine('rbi'),
    getCdpBrowser: () => null
  })
  await assert.rejects(
    Promise.resolve().then(() => router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com', engine: 'chrome' }])),
    /Chrome\/Edge browser engine is not ready/
  )
})

test('routing to a not-ready RBI engine throws a clear error', async () => {
  const router = createRbiRpcRouter({ getRbiBrowser: () => null })
  await assert.rejects(
    Promise.resolve().then(() => router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com' }])),
    /RBI browser is not ready/
  )
})

test('an unknown function is rejected', () => {
  const { router } = fixture()
  assert.throws(() => router.dispatch('rbiBogus', [{ id: 'a' }]), /Unknown browser control function/)
})

test('chrome/edge open is rejected in the system runtime with USER_CONTEXT_REQUIRED', async () => {
  const cdp = fakeEngine('cdp')
  const rbi = fakeEngine('rbi')
  const router = createRbiRpcRouter({
    getRbiBrowser: () => rbi,
    getCdpBrowser: () => cdp,
    isSystemRuntime: () => true
  })
  for (const engine of ['chrome', 'edge']) {
    await assert.rejects(
      Promise.resolve().then(() => router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com', engine }])),
      (error) => error.code === 'USER_CONTEXT_REQUIRED'
    )
  }
  assert.equal(cdp.calls.length, 0, 'the CDP engine is never reached in the system runtime')
})

test('the internal RBI engine still works in the system runtime', async () => {
  const rbi = fakeEngine('rbi')
  const router = createRbiRpcRouter({
    getRbiBrowser: () => rbi,
    getCdpBrowser: () => fakeEngine('cdp'),
    isSystemRuntime: () => true
  })
  await router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com' }])
  assert.equal(rbi.calls.at(-1).method, 'open')
})

test('chrome/edge open is allowed when not in the system runtime', async () => {
  const cdp = fakeEngine('cdp')
  const router = createRbiRpcRouter({
    getRbiBrowser: () => fakeEngine('rbi'),
    getCdpBrowser: () => cdp,
    isSystemRuntime: () => false
  })
  await router.dispatch('rbiOpen', [{ id: 'a', url: 'https://a.com', engine: 'chrome' }])
  assert.equal(cdp.calls.at(-1).method, 'open')
})
