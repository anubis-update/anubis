const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { createExtensionManager, createExtensionStateStore } = require('../../app/lib/cdp-extensions')

const id = 'a'.repeat(32)
const policyId = 'b'.repeat(32)
const storeId = 'c'.repeat(32)

function fixture () {
  const items = [
    { id, name: 'Installed outside Hub', version: '2.0', enabled: false, installType: 'development', mayDisable: true, permissions: ['storage'], hostPermissions: ['https://example.test/*'], path: 'C:\\private\\extension' },
    { id: policyId, name: 'Administrator extension', enabled: true, installType: 'admin', mayDisable: false },
    { id: storeId, name: 'Store extension', enabled: true, installType: 'normal', mayDisable: true }
  ]
  const chrome = {
    runtime: {},
    management: {
      getAll: callback => callback(items),
      setEnabled: (id, value, callback) => {
        items.find(e => e.id === id).enabled = value
        callback()
      }
    },
    developerPrivate: { getProfileConfiguration: done => done({ inDeveloperMode: true }) }
  }
  const opened = []
  const closed = []
  const commands = []
  const tabs = {
    newTab: async options => { opened.push(options); return { tab: { tabId: 'native' } } },
    close: async tabId => { closed.push(tabId) },
    send: async (tabId, method, params) => {
      assert.equal(method, 'Runtime.evaluate')
      assert.equal(params.awaitPromise, true)
      try {
        const value = await vm.runInNewContext(params.expression, { chrome, setTimeout, clearTimeout })
        return { result: { value: JSON.parse(JSON.stringify(value)) } }
      } catch {
        return { exceptionDetails: { text: 'Native failure with C:\\secret\\path' } }
      }
    }
  }
  const client = {
    send: async (method, params) => {
      commands.push(method)
      if (method === 'Extensions.uninstall') items.splice(items.findIndex(e => e.id === params.id), 1)
      return { targetInfos: [{ url: `chrome-extension://${id}/background.js` }] }
    }
  }
  const manager = createExtensionManager({ client, tabs, sleep: async () => {} })
  return { manager, client, tabs, chrome, items, commands, opened, closed }
}

test('native catalog includes existing, disabled, store and policy extensions without local paths', async () => {
  const f = fixture()
  const result = await f.manager.list()
  assert.equal(result.extensions.length, 3)
  assert.equal(result.extensions[0].enabled, false)
  assert.equal(result.extensions[0].installType, 'unpacked')
  assert.deepEqual(result.extensions[0].permissions, ['storage'])
  assert.equal(result.extensions[1].mayModify, false)
  assert.equal(result.extensions[2].installType, 'store')
  assert.equal(result.extensions[2].mayRemove, false)
  assert.equal(result.developerMode, true)
  assert.deepEqual(result.running, [id])
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.deepEqual(f.opened, [{ url: 'chrome://extensions', activate: false }])
  assert.equal(f.closed.length, 1)
})

test('native enable and disable do not uninstall or reload extensions', async () => {
  const f = fixture()
  assert.equal((await f.manager.enable(id)).extension.enabled, true)
  assert.equal((await f.manager.disable(id)).extension.enabled, false)
  assert.equal(f.items.length, 3)
  assert.deepEqual(f.commands, [])
  assert.equal(f.opened.length, f.closed.length)
})

test('new manager reads current browser state instead of remembering earlier commands', async () => {
  const f = fixture()
  await f.manager.enable(id)
  const restarted = createExtensionManager({ client: f.client, tabs: f.tabs })
  assert.equal((await restarted.list()).extensions[0].enabled, true)
  f.items[0].enabled = false
  assert.equal((await restarted.list()).extensions[0].enabled, false)
})

test('native changes respect browser policy and missing extension ids', async () => {
  const f = fixture()
  await assert.rejects(f.manager.disable(policyId), { code: 'POLICY_DENIED' })
  await assert.rejects(f.manager.remove(policyId), { code: 'POLICY_DENIED' })
  await assert.rejects(f.manager.enable('d'.repeat(32)), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.manager.disable('bad-id'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.manager.remove(storeId), { code: 'CAPABILITY_MISSING' })
  assert.deepEqual(f.commands, [])
})

test('native removal uninstalls an existing disabled unpacked extension', async () => {
  const f = fixture()
  assert.deepEqual(await f.manager.remove(id), { removed: true })
  assert.deepEqual(f.commands, ['Extensions.uninstall'])
  assert.ok(!(await f.manager.list()).extensions.some(e => e.extensionId === id))
})

test('native API failure reports an explicit safe error and always closes temporary tab', async () => {
  const f = fixture()
  f.chrome.runtime.lastError = { message: 'C:\\secret\\profile: native rejected request' }
  await assert.rejects(f.manager.list(), error => {
    assert.equal(error.code, 'EXTENSION_REJECTED')
    assert.ok(!error.message.includes('secret'))
    return true
  })
  assert.equal(f.opened.length, f.closed.length)
})

test('unavailable native API is not reported as an empty successful list', async () => {
  const f = fixture()
  delete f.chrome.management
  await assert.rejects(f.manager.list(), { code: 'CAPABILITY_MISSING' })
  assert.equal(f.closed.length, 1)
})

test('saved extension store isolates profiles, stores opaque ids and rejects corrupt data', t => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'anubis-extension-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = createExtensionStateStore({ root, userDataDir: 'managed', profileDirectory: 'Profile 1' })
  const other = createExtensionStateStore({ root, userDataDir: 'managed', profileDirectory: 'Default' })
  assert.deepEqual(store.read(), [])
  const state = [{ extensionId: id, stagedId: 'st_123-extension', enabled: false }]
  store.write(state)
  assert.deepEqual(store.read(), state)
  assert.deepEqual(other.read(), [])
  const file = path.join(root, fs.readdirSync(root)[0])
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Profile 1'))
  fs.writeFileSync(file, JSON.stringify([{ ...state[0], stagedId: '..\\outside' }]))
  assert.throws(() => store.read(), { code: 'EXTENSION_REJECTED' })
  fs.writeFileSync(file, JSON.stringify([state[0], state[0]]))
  assert.throws(() => store.read(), { code: 'EXTENSION_REJECTED' })
  fs.writeFileSync(file, '{}')
  assert.throws(() => store.read(), { code: 'EXTENSION_REJECTED' })
})

test('disabled saved extensions are listed explicitly as not loaded, never executed during restore', async () => {
  const f = fixture()
  f.items.splice(0, 1)
  let written
  const saved = [{ extensionId: id, stagedId: 'st_saved', enabled: false }]
  const manager = createExtensionManager({
    client: f.client,
    tabs: f.tabs,
    extensionState: { read: () => saved, write: state => { written = state } },
    resolveSource: () => 'C:\\staging',
    fsApi: { readFileSync: () => JSON.stringify({ manifest_version: 3, name: 'Saved', version: '1.0' }) }
  })
  await manager.restore()
  assert.deepEqual(f.commands, [])
  const list = await manager.list()
  const item = list.extensions.find(e => e.extensionId === id)
  assert.equal(item.enabled, false)
  assert.equal(item.installed, false)
  await manager.remove(id)
  assert.deepEqual(written, [])
  assert.ok(!f.commands.includes('Extensions.uninstall'))
})

test('native read errors and write errors never become empty successful state', () => {
  const store = createExtensionStateStore({
    root: 'root',
    userDataDir: 'managed',
    fsApi: {
      readFileSync () { throw Object.assign(new Error('Cannot read saved state'), { code: 'EACCES' }) },
      mkdirSync () {},
      writeFileSync () { throw new Error('disk full') }
    }
  })
  assert.throws(() => store.read(), /Cannot read/)
  assert.throws(() => store.write([]), /disk full/)
})
