const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createStorageDriver, httpOrigin } = require('../../app/lib/cdp-storage')

function mk (url, value) {
  const calls = []
  const tabs = {
    info: () => ({ url }),
    send: async (tabId, method, params) => { calls.push({ method, params }); return method === 'Runtime.evaluate' ? { result: { value } } : {} }
  }
  return { drv: createStorageDriver({ tabs }), calls }
}

test('httpOrigin accepts only http(s)', () => {
  assert.equal(httpOrigin('https://a.test/x?y'), 'https://a.test')
  for (const u of ['file:///c:/x', 'chrome://settings', 'about:blank', 'data:text/html,x', 'chrome-extension://abc/x', 'nonsense']) assert.equal(httpOrigin(u), null)
})

test('get/set refuse non-http pages with CAPABILITY_MISSING', async () => {
  const { drv, calls } = mk('chrome://settings', {})
  await assert.rejects(drv.get('t', { kind: 'localStorage' }), (e) => e.code === 'CAPABILITY_MISSING')
  await assert.rejects(drv.set('t', { kind: 'localStorage', entries: { a: '1' } }), (e) => e.code === 'CAPABILITY_MISSING')
  assert.equal(calls.length, 0)
})

test('get returns bounded string entries marked untrusted', async () => {
  const { drv, calls } = mk('https://a.test/p', { k: 'v', n: 3 })
  const r = await drv.get('t', { kind: 'localStorage', keys: ['k'] })
  assert.deepEqual(r.entries, { k: 'v', n: '3' })
  assert.equal(r.untrusted, true)
  assert.match(calls[0].params.expression, /window\.localStorage/)
  assert.match(calls[0].params.expression, /\["k"\]/)
})

test('get indexedDB.names and unknown kind', async () => {
  const { drv } = mk('http://a.test/', ['db1'])
  assert.deepEqual(JSON.parse((await drv.get('t', { kind: 'indexedDB.names' })).entries.names), ['db1'])
  await assert.rejects(drv.get('t', { kind: 'cookies' }), (e) => e.code === 'INVALID_REQUEST')
})

test('set serialises entries safely and counts', async () => {
  const { drv, calls } = mk('https://a.test/', 2)
  const r = await drv.set('t', { kind: 'sessionStorage', entries: { a: '1', b: '"};alert(1)//' } })
  assert.equal(r.set, 2)
  assert.match(calls[0].params.expression, /window\.sessionStorage/)
  assert.ok(calls[0].params.expression.includes(JSON.stringify({ a: '1', b: '"};alert(1)//' })))
})

test('clear needs a plain http(s) origin and maps types', async () => {
  const { drv, calls } = mk('https://a.test/', null)
  await assert.rejects(drv.clear('t', { origin: 'file:///c:/' }), (e) => e.code === 'INVALID_REQUEST')
  await assert.rejects(drv.clear('t', { origin: 'https://a.test/path' }), (e) => e.code === 'INVALID_REQUEST')
  await drv.clear('t', { origin: 'https://a.test', types: ['cache', 'local_storage'] })
  assert.deepEqual(calls[0], { method: 'Storage.clearDataForOrigin', params: { origin: 'https://a.test', storageTypes: 'cache_storage,local_storage' } })
})
