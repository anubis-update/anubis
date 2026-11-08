const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { encryptPasswordFile, decryptPasswordFile } = require('../../app/lib/browser-api/password-file')
const { createPasswordTransfer } = require('../../app/lib/browser-api/password-transfer')
const { createNativePasswordTransfer } = require('../../app/lib/browser-api/password-native-transfer')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')

const password = 'public-test-passphrase'
const csv = () => Buffer.from('name,url,username,password\nSynthetic,https://example.test,public-fixture,not-a-real-password\n')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function settled (manager, job) {
  for (let i = 0; i < 100; i++) {
    const result = manager.status({ jobId: job.jobId })
    if (['succeeded', 'failed', 'cancelled'].includes(result.state)) return result
    await wait(10)
  }
  throw new Error('Transfer did not settle')
}
function fixture (native) {
  let allowed = true
  const audit = []
  const driver = { engine: 'chrome', nativePasswordTransfer: async (id, transfer, options) => transfer(options) }
  const api = {
    hub: { forBrowser: () => driver },
    policy: { evaluate: () => ({ effect: allowed ? 'allow' : 'deny' }) },
    leases: { check () {} },
    audit: { record: entry => audit.push(entry) }
  }
  const manager = createPasswordTransfer({ api, actor: { id: 'ui', role: 'admin' }, nativeTransfer: native || (async () => ({ plain: csv() })) })
  return { manager, api, driver, audit, deny: () => { allowed = false } }
}

test('password files: authenticated CSV encryption, fresh nonces, bounds and wrong-file rejection', async () => {
  const plain = csv()
  const encrypted = await encryptPasswordFile(plain, password)
  assert.equal(encrypted.format, 'anubis-passwords-v1')
  assert(!JSON.stringify(encrypted).includes('not-a-real-password'))
  assert.deepEqual(await decryptPasswordFile(encrypted, password), plain)
  assert.notEqual(encrypted.data, (await encryptPasswordFile(plain, password)).data)
  await assert.rejects(decryptPasswordFile(encrypted, 'wrong-public-test-password'), { code: 'INVALID_REQUEST' })
  await assert.rejects(decryptPasswordFile({ ...encrypted, format: 'anubis-cookies-v1' }, password), { code: 'INVALID_REQUEST' })
  await assert.rejects(decryptPasswordFile({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }, password), { code: 'INVALID_REQUEST' })
  await assert.rejects(encryptPasswordFile(Buffer.from('invalid,csv\n'), password), { code: 'INVALID_REQUEST' })
  await assert.rejects(encryptPasswordFile(plain, 'short'), { code: 'INVALID_REQUEST' })
  await assert.rejects(decryptPasswordFile({ ...encrypted, data: 'A'.repeat(3 * 1024 * 1024 + 1) }, password), { code: 'INVALID_REQUEST' })
})

test('admin password jobs: consent/policy, encrypted-only result, no secret audit, actual native success required', async () => {
  const f = fixture()
  const payload = { browserId: 'b_1', confirmed: true, passphrase: password }
  assert.throws(() => f.manager.start('export', { ...payload, confirmed: false }), { code: 'INVALID_REQUEST' })
  const exported = await settled(f.manager, f.manager.start('export', payload))
  assert.equal(exported.state, 'succeeded')
  assert(!JSON.stringify(exported).includes('not-a-real-password'))
  const result = f.manager.result({ jobId: exported.jobId })
  assert.deepEqual(await decryptPasswordFile(result.artifact, password), csv())
  assert(!JSON.stringify(f.audit).includes(password))
  assert(!JSON.stringify(f.audit).includes('not-a-real-password'))
  f.deny()
  assert.throws(() => f.manager.result({ jobId: exported.jobId }), { code: 'POLICY_DENIED' })
  assert.throws(() => f.manager.start('import', payload), { code: 'POLICY_DENIED' })
  const invalid = fixture(async () => ({}))
  const rejected = await settled(invalid.manager, invalid.manager.start('import', { ...payload, artifact: result.artifact }))
  assert.equal(rejected.state, 'failed')
  assert.equal(rejected.error.code, 'IMPORT_FAILED')
})

test('native transfer jobs serialize, cancel awaiting approval and wipe decrypted buffers', async () => {
  let nativePlain
  const f = fixture(async ({ plain, signal, progress }) => {
    nativePlain = plain
    progress('waiting_for_windows_approval')
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const artifact = await encryptPasswordFile(csv(), password)
  const request = { browserId: 'b_1', confirmed: true, passphrase: password, artifact }
  const job = f.manager.start('import', request)
  assert.throws(() => f.manager.start('export', request), { code: 'BUSY' })
  for (let i = 0; i < 100; i++) { if (nativePlain) break; await wait(10) }
  assert(nativePlain)
  f.manager.cancel({ jobId: job.jobId })
  assert.equal((await settled(f.manager, job)).state, 'cancelled')
  assert(nativePlain.every(byte => byte === 0))
  assert.equal(f.manager.status().state, 'cancelled')
})

test('decrypted password import rechecks policy before any native browser action', async () => {
  let invoked = false
  const f = fixture(async () => { invoked = true; return { imported: true } })
  const artifact = await encryptPasswordFile(csv(), password)
  const job = f.manager.start('import', { browserId: 'b_1', confirmed: true, passphrase: password, artifact })
  f.deny()
  assert.equal((await settled(f.manager, job)).error.code, 'POLICY_DENIED')
  assert.equal(invoked, false)
})

test('Hub exposes native password jobs only as explicit admin actions; generic secret commands stay denied', async () => {
  const f = fixture()
  const hub = createBrowserHubController({ api: f.api, tokens: {}, nativePasswordTransfer: async () => ({ plain: csv() }) })
  assert.equal((await hub.handle('passwords.transferStatus', {})).result.state, 'idle')
  const job = await hub.handle('passwords.exportFile', { browserId: 'b_1', confirmed: true, passphrase: password })
  assert.equal(job.ok, true)
  assert.equal((await hub.handle('command.execute', { command: 'passwords.export' })).error.code, 'POLICY_DENIED')
  hub.dispose()
})

test('native adapter refuses non-Windows/no process identity before creating any files', async () => {
  const transfer = createNativePasswordTransfer({ platform: 'linux' })
  await assert.rejects(transfer({}), { code: 'NOT_SUPPORTED_BY_ENGINE' })
  await assert.rejects(createNativePasswordTransfer({ platform: 'win32' })({ pid: 0 }), { code: 'CAPABILITY_MISSING' })
})

test('native adapter confines clicks to native settings, confirms import and removes temporary CSV', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-native-password-unit-'))
  let directory
  let selected = false
  let closed = false
  const snapshots = [
    { role: { value: 'button' }, name: { value: 'Select file' }, backendDOMNodeId: 1 }
  ]
  const tabs = {
    newTab: async () => ({ tab: { tabId: 't_native' } }),
    get: () => ({ url: 'chrome://password-manager/settings' }),
    close: async () => { closed = true },
    send: async (id, method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: selected ? [{ name: { value: '1 password imported to Google Password Manager on this device' } }] : snapshots }
      if (method === 'DOM.getBoxModel') return { model: { width: 10, height: 10, content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      return {}
    }
  }
  const transfer = createNativePasswordTransfer({
    root,
    platform: 'win32',
    makeDirectory: async () => { directory = await fs.mkdtemp(path.join(root, 'transfer-')); return directory },
    dialog: async request => {
      if (request.action === 'inspect') return { acted: false }
      if (request.action === 'select') {
        assert.deepEqual(await fs.readFile(request.path), csv())
        assert.equal(path.dirname(request.path), directory)
        selected = true
      }
      return { acted: true }
    }
  })

  try {
    const result = await transfer({ engine: 'chrome', tabs, pid: 123, kind: 'import', plain: csv(), signal: new AbortController().signal, check () {}, progress () {} })
    assert.deepEqual(result, { imported: true })
    assert(closed)
    assert.deepEqual(await fs.readdir(root), [])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('native job policy change during export never releases an encrypted result', async () => {
  let release
  const f = fixture(() => new Promise(resolve => { release = resolve }))
  const job = f.manager.start('export', { browserId: 'b_1', confirmed: true, passphrase: password })
  for (let i = 0; i < 100; i++) { if (release) break; await wait(10) }
  assert(release)
  f.deny()
  const plain = csv()
  release({ plain })
  const result = await settled(f.manager, job)
  assert.equal(result.state, 'failed')
  assert.equal(result.error.code, 'POLICY_DENIED')
  assert(plain.every(byte => byte === 0))
  assert.equal(result.artifactReady, false)
})

test('native completed artifacts expire and disposal refuses new work', async () => {
  let now = 100
  const f = fixture()
  const manager = createPasswordTransfer({ api: f.api, actor: { id: 'ui', role: 'admin' }, nativeTransfer: async () => ({ plain: csv() }), now: () => now, retainMs: 100 })
  const job = manager.start('export', { browserId: 'b_1', confirmed: true, passphrase: password })
  assert.equal((await settled(manager, job)).artifactReady, true)
  now += 101
  assert.equal(manager.status().state, 'idle')
  assert.throws(() => manager.result({ jobId: job.jobId }), { code: 'NOT_FOUND' })
  manager.dispose()
  assert.throws(() => manager.start('export', {}), { code: 'DISABLED' })
})

test('native adapter refuses pre-existing file dialogs without writing plaintext or clicking controls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-native-preexisting-'))
  let written = false
  const transfer = createNativePasswordTransfer({
    root,
    platform: 'win32',
    makeDirectory: async () => { written = true },
    dialog: async () => ({ acted: true })
  })
  try {
    await assert.rejects(transfer({ engine: 'chrome', pid: 123, kind: 'import', signal: new AbortController().signal }), { code: 'BUSY' })
    assert.equal(written, false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('cancellation must surface native cleanup failure instead of reporting a clean cancellation', async () => {
  let ready = false
  const f = fixture(async ({ signal }) => {
    ready = true
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw Object.assign(new Error('Native transfer cleanup did not complete'), { code: 'CLEANUP_FAILED' })
  })
  const job = f.manager.start('export', { browserId: 'b_1', confirmed: true, passphrase: password })
  for (let i = 0; i < 100; i++) { if (ready) break; await wait(10) }
  assert(ready)
  f.manager.cancel({ jobId: job.jobId })
  const result = await settled(f.manager, job)
  assert.equal(result.state, 'failed')
  assert.equal(result.error.code, 'CLEANUP_FAILED')
})

async function exportFixture (run, { cleanupFailure = false, navigate = false, cancel = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-native-export-unit-'))
  const controller = new AbortController()
  let closed = false
  let cancelled = false
  let url = 'chrome://password-manager/settings'
  const tabs = {
    newTab: async () => ({ tab: { tabId: 't_export' } }),
    get: () => ({ url }),
    close: async () => {
      closed = true
      if (cleanupFailure) throw new Error('test close failure')
    },
    send: async (id, method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: 'Download file' }, backendDOMNodeId: 1 }] }
      if (method === 'DOM.getBoxModel') return { model: { width: 10, height: 10, content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'Input.dispatchMouseEvent' && cancel) controller.abort()
      return {}
    }
  }
  const transfer = createNativePasswordTransfer({
    root,
    platform: 'win32',
    makeDirectory: () => fs.mkdtemp(path.join(root, 'transfer-')),
    dialog: async request => {
      if (request.action === 'inspect') return { acted: false }
      if (request.action === 'cancel') { cancelled = true; return { acted: true } }
      assert.equal(path.basename(request.path), 'passwords.csv')
      await fs.writeFile(request.path, csv(), { flag: 'wx' })
      if (navigate) url = 'https://example.test/'
      return { acted: true }
    }
  })
  try {
    await run(() => transfer({ engine: 'chrome', tabs, pid: 123, kind: 'export', signal: controller.signal, check () {}, progress () {} }))
    assert(closed)
    if (cancel) assert(cancelled)
    assert.deepEqual(await fs.readdir(root), [])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}

test('native export reads a stable bounded CSV and cleans the device directory before returning', async () => {
  await exportFixture(async transfer => {
    const { plain } = await transfer()
    assert.deepEqual(plain, csv())
    const artifact = await encryptPasswordFile(plain, password)
    plain.fill(0)
    assert.deepEqual(await decryptPasswordFile(artifact, password), csv())
  })
})

test('native export cleanup failure never returns plaintext as a successful result', async () => {
  await exportFixture(transfer => assert.rejects(transfer(), { code: 'CLEANUP_FAILED' }), { cleanupFailure: true })
})

test('native export rejects settings-page navigation while waiting and removes its file', async () => {
  await exportFixture(transfer => assert.rejects(transfer(), { code: 'POLICY_DENIED' }), { navigate: true })
})

test('native export cancellation closes only its own tab and cancels its expected picker', async () => {
  await exportFixture(transfer => assert.rejects(transfer(), { code: 'CANCELLED' }), { cancel: true })
})

test('native startup recovery removes only its own interrupted transfer directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-native-recovery-unit-'))
  const stale = path.join(root, 'transfer-Ab12cd')
  const keep = path.join(root, 'unrelated')
  await fs.mkdir(stale)
  await fs.writeFile(path.join(stale, 'passwords.csv'), csv())
  await fs.mkdir(keep)
  const transfer = createNativePasswordTransfer({ root, platform: 'win32', dialog: async () => ({ acted: true }) })
  try {
    await assert.rejects(transfer({ pid: 123, kind: 'import', signal: new AbortController().signal }), { code: 'BUSY' })
    assert.deepEqual(await fs.readdir(root), ['unrelated'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

async function checkModalCancellation (timeout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anubis-native-modal-unit-'))
  const controller = new AbortController()
  let dismiss
  let waiting
  const waitingReady = new Promise(resolve => { waiting = resolve })
  const tabs = {
    newTab: async () => ({ tab: { tabId: 't_modal' } }),
    get: () => ({ url: 'chrome://password-manager/settings' }),
    close: () => new Promise(resolve => { dismiss = resolve }),
    send: async (id, method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'button' }, name: { value: 'Download file' }, backendDOMNodeId: 1 }] }
      if (method === 'DOM.getBoxModel') return { model: { width: 10, height: 10, content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      return {}
    }
  }
  const transfer = createNativePasswordTransfer({
    root,
    platform: 'win32',
    cleanupGraceMs: 1,
    cleanupWaitMs: timeout ? 10 : 500,
    makeDirectory: () => fs.mkdtemp(path.join(root, 'transfer-')),
    dialog: async () => ({ acted: false })
  })
  const request = {
    engine: 'chrome',
    tabs,
    pid: 123,
    kind: 'export',
    signal: controller.signal,
    check () {},
    progress: state => {
      if (state === 'waiting_for_windows_approval') controller.abort()
      if (state === 'waiting_for_windows_dismissal') waiting()
    }
  }
  const result = assert.rejects(transfer(request), { code: timeout ? 'NATIVE_APPROVAL_REQUIRED' : 'CANCELLED' })
  try {
    await waitingReady
    assert.deepEqual(await fs.readdir(root), [])
    await assert.rejects(transfer({ ...request, signal: new AbortController().signal }), { code: 'BUSY' })
    if (timeout) {
      await result
      await assert.rejects(transfer({ ...request, signal: new AbortController().signal }), { code: 'BUSY' })
    }
    dismiss()
    await result
  } finally { if (dismiss) dismiss(); await fs.rm(root, { recursive: true, force: true }) }
}

test('Windows-modal cancellation removes data first, waits for owner dismissal and blocks another transfer', async () => {
  await checkModalCancellation(false)
})

test('Windows-modal cancellation deadline reports desktop approval required and keeps the pending-close guard', async () => {
  await checkModalCancellation(true)
})

test('Windows-modal wait remains visible after cancellation and is not reported as completed cleanup', async () => {
  const f = fixture(async ({ signal, progress }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    progress('waiting_for_windows_dismissal')
    await wait(30)
    throw Object.assign(new Error('Dismiss Windows Security on the device desktop'), { code: 'NATIVE_APPROVAL_REQUIRED' })
  })
  const job = f.manager.start('export', { browserId: 'b_1', confirmed: true, passphrase: password })
  await wait(10)
  f.manager.cancel({ jobId: job.jobId })
  await wait(10)
  assert.equal(f.manager.status().state, 'waiting_for_windows_dismissal')
  const result = await settled(f.manager, job)
  assert.equal(result.state, 'failed')
  assert.equal(result.error.code, 'NATIVE_APPROVAL_REQUIRED')
})
