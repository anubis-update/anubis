const { test } = require('node:test')
const assert = require('node:assert/strict')
const { encryptCookies, decryptCookies, createCookieTransfer } = require('../../app/lib/browser-api/cookie-transfer')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')

const password = 'public-test-passphrase'
const cookies = [{ name: 'fixture', value: 'public-session-fixture', domain: '.example.test', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 }]

test('encrypted cookies: authenticated file roundtrip, fresh nonces and no plaintext', async () => {
  const first = await encryptCookies(cookies, password)
  const second = await encryptCookies(cookies, password)
  assert.notEqual(first.data, second.data)
  assert(!JSON.stringify(first).includes(cookies[0].value))
  assert.deepEqual(await decryptCookies(first, password), cookies)
  await assert.rejects(decryptCookies(first, 'incorrect-test-passphrase'), { code: 'INVALID_REQUEST' })
  await assert.rejects(decryptCookies({ ...first, tag: Buffer.alloc(16).toString('base64') }, password), { code: 'INVALID_REQUEST' })
  await assert.rejects(decryptCookies({ ...first, salt: '*'.repeat(10) }, password), { code: 'INVALID_REQUEST' })
  await assert.rejects(encryptCookies(cookies, 'short'), { code: 'INVALID_REQUEST' })
  await assert.rejects(encryptCookies([{ ...cookies[0], domain: 'https://bad.test/path' }], password), { code: 'INVALID_REQUEST' })
})

function fixture () {
  const audit = []
  const imports = []
  let allowed = true
  const driver = { engine: 'chrome', cookies: async () => cookies, setCookies: async (id, list) => { imports.push(list); return { count: list.length } }, newTab: async (id, params) => ({ tab: params }) }
  const api = {
    hub: { forBrowser: () => driver },
    policy: { evaluate: () => ({ effect: allowed ? 'allow' : 'deny' }) },
    leases: { check () {} },
    audit: { record: item => audit.push(item) }
  }
  return { api, audit, imports, deny: () => { allowed = false } }
}

test('admin cookies: explicit consent, domain selection, policy, no secret audit or plaintext return', async () => {
  const f = fixture()
  const transfer = createCookieTransfer({ api: f.api, actor: { id: 'ui', role: 'admin' } })
  const request = { browserId: 'b_1', confirmed: true, passphrase: password, domains: ['example.test'] }
  await assert.rejects(transfer('export', { ...request, confirmed: false }), { code: 'INVALID_REQUEST' })
  await assert.rejects(transfer('export', { ...request, domains: [] }), { code: 'INVALID_REQUEST' })
  const exported = await transfer('export', request)
  assert.equal(exported.count, 1)
  assert(!JSON.stringify(exported).includes(cookies[0].value))
  assert.equal((await transfer('import', { ...request, artifact: exported.artifact })).count, 1)
  assert.deepEqual(f.imports[0], cookies)
  assert(!JSON.stringify(f.audit).includes(password))
  assert(!JSON.stringify(f.audit).includes(cookies[0].value))
  f.deny()
  await assert.rejects(transfer('export', request), { code: 'POLICY_DENIED' })
})

test('Hub data tools: only encrypted artifacts and native UI, generic secret commands stay blocked', async () => {
  const f = fixture()
  const controller = createBrowserHubController({ api: f.api, tokens: {} })
  const exported = await controller.handle('cookies.exportFile', { browserId: 'b_1', confirmed: true, domains: ['example.test'], passphrase: password })
  assert.equal(exported.ok, true)
  assert.equal(exported.result.artifact.format, 'anubis-cookies-v1')
  const native = await controller.handle('passwords.openNative', { browserId: 'b_1', confirmed: true })
  assert.equal(native.result.tab.url, 'chrome://password-manager/settings')
  assert.equal((await controller.handle('passwords.openNative', { browserId: 'b_1' })).ok, false)
  for (const command of ['cookies.export', 'cookies.import', 'passwords.export', 'passwords.import']) {
    assert.equal((await controller.handle('command.execute', { command })).error.code, 'POLICY_DENIED')
  }
})

test('cookie imports recheck policy after decryption and serialize transfers', async () => {
  const f = fixture()
  const transfer = createCookieTransfer({ api: f.api, actor: { id: 'ui', role: 'admin' } })
  const request = { browserId: 'b_1', confirmed: true, passphrase: password, artifact: await encryptCookies(cookies, password) }
  const pending = transfer('import', request)
  await assert.rejects(transfer('import', request), { code: 'BUSY' })
  f.deny()
  await assert.rejects(pending, { code: 'POLICY_DENIED' })
  assert.equal(f.imports.length, 0)
})
