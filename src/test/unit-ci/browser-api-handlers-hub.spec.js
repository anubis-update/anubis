const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHandlers } = require('../../app/lib/browser-api/command-handlers')

function mk ({ allowInstall = true, staging, vault } = {}) {
  const calls = []
  const rec = (name) => (...a) => { calls.push([name, ...a]); return { name } }
  const pageApi = {
    click: async (...a) => { calls.push(['click', ...a]) },
    select: async (...a) => { calls.push(['select', ...a]); return { selected: 1 } },
    upload: async (...a) => { calls.push(['upload', ...a]); return { uploaded: 2 } }
  }
  const ext = {
    list: rec('list'),
    install: async (a) => { calls.push(['install', a]); return { extension: { extensionId: 'x' } } },
    enable: rec('enable'),
    disable: rec('disable'),
    remove: rec('remove'),
    setDevMode: async (e) => { calls.push(['devMode', e]); return { enabled: e, method: 'ui-toggle' } }
  }
  const storageApi = { get: rec('sget'), set: rec('sset'), clear: rec('sclear') }
  const driver = {
    page: () => pageApi,
    extensionsOf: () => ext,
    storage: () => storageApi,
    downloads: (b, o) => ({ items: [], b, o }),
    clearHistory: async (b, o) => ({ cleared: true, b, o })
  }
  const policy = {
    extensions: () => ({ allowInstall }),
    checkUrl: (u) => (/evil/.test(u) ? { ok: false, reason: 'denied' } : { ok: true }),
    limits: () => ({})
  }
  const h = createHandlers({ hub: { drivers: () => [] }, policy, leases: {}, staging, vault })
  const run = (name, params, extra = {}) => h[name]({ params, driver, browserId: 'b1', tabId: 't1', actor: {}, ...extra })
  return { run, calls }
}

const stagingFake = {
  resolveDir: (id) => { if (id !== 'ok1') throw Object.assign(new Error('x'), { code: 'INVALID_REQUEST' }); return 'C:\\stage\\ext' },
  resolveFiles: (items) => items.map((i) => 'C:\\stage\\' + i.stagedId),
  resolveFile: (id) => ({ path: 'C:\\stage\\' + id })
}

test('coordinate and ref targets; invalid target rejected', async () => {
  const { run, calls } = mk()
  await run('page.click', { target: { x: 5, y: 6 } })
  await run('page.click', { target: { ref: 'e1', snapshotId: 's1' } })
  assert.deepEqual(calls[0].slice(1), ['t1', { x: 5, y: 6, button: undefined, clickCount: undefined }])
  assert.equal(calls[1][2].ref, 'e1')
  await assert.rejects(run('page.click', { target: {} }), (e) => e.code === 'INVALID_REQUEST')
})

test('page.select and page.upload (staged files only)', async () => {
  const { run, calls } = mk({ staging: stagingFake })
  const s = await run('page.select', { target: { x: 1, y: 2 }, values: ['a'] })
  assert.equal(s.selected, 1)
  const u = await run('page.upload', { target: { ref: 'e2' }, files: [{ stagedId: 'f1' }, { stagedId: 'f2' }] })
  assert.equal(u.uploaded, 2)
  assert.deepEqual(calls.find((c) => c[0] === 'upload')[2].files, ['C:\\stage\\f1', 'C:\\stage\\f2'])
  await assert.rejects(mk().run('page.upload', { target: { ref: 'e' }, files: [{ stagedId: 'f' }] }), (e) => e.code === 'CAPABILITY_MISSING')
})

test('extension.install is default-deny, rejects crx, validates staged dir', async () => {
  const off = mk({ allowInstall: false, staging: stagingFake })
  await assert.rejects(off.run('extension.install', { source: { type: 'unpacked', stagedId: 'ok1' } }), (e) => e.code === 'POLICY_DENIED')
  await assert.rejects(off.run('extension.enable', { extensionId: 'a' }), (e) => e.code === 'POLICY_DENIED')
  const on = mk({ staging: stagingFake })
  await assert.rejects(on.run('extension.install', { source: { type: 'crx', stagedId: 'ok1', sha256: 'a'.repeat(64) } }), (e) => e.code === 'CAPABILITY_MISSING')
  await assert.rejects(on.run('extension.install', { source: { type: 'unpacked', stagedId: 'bad' } }), (e) => e.code === 'INVALID_REQUEST')
  await on.run('extension.install', { source: { type: 'unpacked', stagedId: 'ok1' } })
  assert.deepEqual(on.calls.find((c) => c[0] === 'install')[1], { source: { stagedId: 'ok1' } })
  await on.run('extension.install', { source: { type: 'catalog', catalogId: 'c1' } })
  assert.deepEqual(on.calls.filter((c) => c[0] === 'install')[1][1], { source: { catalogId: 'c1' } })
})

test('extension list/disable/remove and devMode.set go to the manager', async () => {
  const { run, calls } = mk({ allowInstall: false })
  await run('extension.list', {})
  await run('extension.disable', { extensionId: 'a' })
  await run('extension.remove', { extensionId: 'a' })
  assert.deepEqual(await run('devMode.set', { enabled: true }), { enabled: true, method: 'ui-toggle' })
  assert.deepEqual(calls.map((c) => c[0]), ['list', 'disable', 'remove', 'devMode'])
})

test('storage, downloads and history.clear', async () => {
  const { run, calls } = mk()
  await run('storage.get', { kind: 'localStorage', keys: ['a'] })
  await run('storage.set', { kind: 'sessionStorage', entries: { a: '1' } })
  await run('storage.clear', { origin: 'https://a.test', types: ['cookies'] })
  assert.deepEqual(calls.map((c) => c[0]), ['sget', 'sset', 'sclear'])
  await assert.rejects(async () => run('storage.clear', { origin: 'https://evil.test' }), (e) => e.code === 'POLICY_DENIED')
  assert.equal((await run('downloads.list', { limit: 3 })).o.limit, 3)
  assert.deepEqual(await run('history.clear', { since: 1 }), { cleared: true, b: 'b1', o: { since: 1, until: undefined } })
})

test('page.title returns bounded untrusted metadata and rejects a bad evaluation', async () => {
  const calls = []
  const handlers = createHandlers({ hub: { drivers: () => [] }, policy: { limits: () => ({}) }, leases: {} })
  const run = value => handlers['page.title']({
    tabId: 't1',
    driver: {
      page: () => ({
        evaluate: async (tabId, options) => {
          calls.push([tabId, options])
          return { value }
        }
      })
    }
  })
  const result = await run({ title: 'T'.repeat(10001), url: 'https://example.test/path', extra: 'dropped' })
  assert.equal(result.title.length, 10000)
  assert.equal(result.url, 'https://example.test/path')
  assert.equal(result.untrusted, true)
  assert.deepEqual(Object.keys(result).sort(), ['title', 'untrusted', 'url'])
  assert.deepEqual(calls, [['t1', { expression: '({title:document.title,url:location.href})' }]])
  for (const bad of [null, {}, { title: 'ok' }, { title: 1, url: 'https://example.test/' }, { title: 'ok', url: null }]) {
    await assert.rejects(run(bad), { code: 'INTERNAL' })
  }
})

test('aegis handlers allow only admin or operator and rewrite scanner error codes', () => {
  const calls = []
  const aegis = (action, params) => {
    calls.push(action)
    if (params && params.fail === 'scanner') throw Object.assign(new Error('module path rejected'), { code: 'E_MODULE_PATH' })
    if (params && params.fail === 'busy') throw Object.assign(new Error('scan running'), { code: 'BUSY' })
    return { ok: action }
  }
  const handlers = createHandlers({ hub: { drivers: () => [] }, policy: { limits: () => ({}) }, leases: {}, aegis })
  const run = (role, action, params = {}) => handlers['aegis.' + action]({ params, actor: { role } })
  assert.throws(() => run('agent', 'settings'), { code: 'FORBIDDEN' })
  assert.throws(() => run(undefined, 'latest'), { code: 'FORBIDDEN' })
  assert.equal(calls.length, 0)
  assert.deepEqual(run('admin', 'settings'), { ok: 'settings' })
  assert.deepEqual(run('operator', 'cancel'), { ok: 'cancel' })
  assert.throws(() => run('admin', 'start', { fail: 'scanner' }), (error) => error.code === 'INVALID_REQUEST' && error.message === 'module path rejected')
  assert.throws(() => run('operator', 'get', { fail: 'busy' }), { code: 'BUSY' })
  const missing = createHandlers({ hub: { drivers: () => [] }, policy: { limits: () => ({}) }, leases: {} })
  assert.throws(() => missing['aegis.start']({ params: {}, actor: { role: 'agent' } }), { code: 'FORBIDDEN' })
  assert.throws(() => missing['aegis.settings']({ params: {}, actor: { role: 'admin' } }), { code: 'CAPABILITY_MISSING' })
})

test('passwords import/export are CAPABILITY_MISSING with a reason and never return content', async () => {
  let inspected
  const { run } = mk({ staging: stagingFake, vault: { inspectStaged: (p) => { inspected = p; return { bytes: 1 } } } })
  await assert.rejects(run('passwords.import', { stagedId: 'pw1' }), (e) => e.code === 'CAPABILITY_MISSING' && /native file dialogs/.test(e.message))
  assert.equal(inspected, 'C:\\stage\\pw1')
  await assert.rejects(async () => run('passwords.export', {}), (e) => e.code === 'CAPABILITY_MISSING' && /native file dialogs/.test(e.message))
})
