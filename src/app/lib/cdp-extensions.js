/**
 * Unpacked MV3 extension management over CDP `Extensions.*` plus the developer
 * mode toggle (SPEC-v1 extension.* / devMode.set).
 *
 * - Only UNPACKED Manifest V3 directories are accepted, and only from sources
 *   the host resolves (quarantine `stagedId` / local `catalogId`): the API never
 *   receives a filesystem path from an agent.
 * - `Extensions.loadUnpacked` needs `--enable-unsafe-extension-debugging` at
 *   launch (see cdp-launch.js) and a pipe/port connection.
 * - Developer mode is NOT written to `Preferences`. If an administrator policy
 *   (ExtensionDeveloperModeSettings) decides it, the policy wins; otherwise the
 *   toggle on the browser's own extensions page is flipped through the UI.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { apiError } = require('./browser-api/errors')

const MAX_FILES = 3000
const MAX_BYTES = 64 * 1024 * 1024

function createExtensionStateStore ({ root, userDataDir, profileDirectory = 'Default', fsApi = fs }) {
  const key = crypto.createHash('sha256').update(path.resolve(userDataDir) + '\0' + profileDirectory).digest('hex')
  const file = path.join(root, key + '.json')
  return {
    read () {
      let raw
      try { raw = fsApi.readFileSync(file, 'utf8') } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const state = JSON.parse(raw)
      if (!Array.isArray(state) || state.length > 200 || state.some(item =>
        !item || !/^[a-p]{32}$/.test(item.extensionId) ||
        typeof item.stagedId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(item.stagedId) ||
        /[. ]$/.test(item.stagedId) || typeof item.enabled !== 'boolean'
      ) || new Set(state.map(item => item.extensionId)).size !== state.length) throw apiError('EXTENSION_REJECTED', 'Saved extension state is invalid')
      return state.map(({ extensionId, stagedId, enabled }) => ({ extensionId, stagedId, enabled }))
    },
    write (state) {
      fsApi.mkdirSync(root, { recursive: true })
      const temporary = file + '.tmp'
      fsApi.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
      fsApi.renameSync(temporary, file)
    }
  }
}

// Runs only on the browser's own extensions page, never on a website.
async function nativeExtensions (operation, extensionId, enabled) {
  const chrome = globalThis.chrome
  if (!chrome || !chrome.management || !chrome.management.getAll ||
      !chrome.developerPrivate || !chrome.developerPrivate.getProfileConfiguration) return null
  const request = call => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser extension operation timed out')), 4000)
    try {
      call(value => {
        clearTimeout(timer)
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve(value)
      })
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
  const all = await request(done => chrome.management.getAll(done))
  if (operation === 'setEnabled') {
    const extension = all.find(e => e.id === extensionId)
    if (!extension) return { error: 'NOT_FOUND' }
    if (!extension.mayDisable || extension.installType === 'admin') return { error: 'POLICY' }
    await request(done => chrome.management.setEnabled(extensionId, enabled, done))
    const updated = await request(done => chrome.management.getAll(done))
    const item = updated.find(e => e.id === extensionId)
    if (!item || item.enabled !== enabled) return { error: 'NOT_CHANGED' }
    return { changed: true }
  }
  const profile = await request(done => chrome.developerPrivate.getProfileConfiguration(done))
  return {
    developerMode: !!profile.inDeveloperMode,
    extensions: all.map(e => ({
      extensionId: e.id,
      name: String(e.name || '').slice(0, 100),
      version: String(e.version || '').slice(0, 100),
      enabled: !!e.enabled,
      installType: e.installType === 'development' ? 'unpacked' : e.installType === 'admin' ? 'policy' : e.installType === 'normal' ? 'store' : 'other',
      mayModify: !!e.mayDisable && e.installType !== 'admin',
      mayRemove: !!e.mayDisable && e.installType === 'development',
      permissions: (e.permissions || []).filter(p => typeof p === 'string').slice(0, 50),
      hostPermissions: (e.hostPermissions || []).filter(p => typeof p === 'string').slice(0, 50)
    }))
  }
}

const DEV_MODE_TOGGLE = (want) => `(() => {
  const m = document.querySelector('extensions-manager')
  const t = m && m.shadowRoot && m.shadowRoot.querySelector('extensions-toolbar')
  const edgeToggle = (root) => {
    const found = root.querySelector('#dev-switch')
    if (found) return found
    for (const node of root.querySelectorAll('*')) {
      if (!node.shadowRoot) continue
      const toggle = edgeToggle(node.shadowRoot)
      if (toggle) return toggle
    }
    return null
  }
  const tg = (t && t.shadowRoot && t.shadowRoot.querySelector('#devMode')) || edgeToggle(document)
  if (!tg) return null
  if (${want === null ? 'false' : `tg.checked !== ${!!want}`}) tg.click()
  return !!tg.checked
})()`

function walkDir (dir, fsApi, state = { files: 0, bytes: 0 }) {
  for (const ent of fsApi.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isSymbolicLink && ent.isSymbolicLink()) throw apiError('EXTENSION_REJECTED', 'Extension contains a symbolic link')
    if (ent.isDirectory()) walkDir(full, fsApi, state)
    else {
      state.files++
      state.bytes += fsApi.statSync(full).size
    }
    if (state.files > MAX_FILES || state.bytes > MAX_BYTES) throw apiError('LIMIT_EXCEEDED', 'Extension is too large')
  }
  return state
}

function readManifest (dir, fsApi) {
  let manifest
  try {
    manifest = JSON.parse(String(fsApi.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    throw apiError('EXTENSION_REJECTED', 'manifest.json is missing or invalid')
  }
  if (!manifest || manifest.manifest_version !== 3) throw apiError('EXTENSION_REJECTED', 'Only unpacked Manifest V3 extensions are supported')
  if (typeof manifest.name !== 'string' || !manifest.name) throw apiError('EXTENSION_REJECTED', 'manifest.json has no name')
  return manifest
}

function createExtensionManager ({
  client,
  tabs,
  engine = 'chrome',
  fsApi = fs,
  resolveSource,
  extensionState,
  readDevModePolicy = () => undefined,
  devModeUi = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!client) throw new TypeError('cdp-extensions requires a CDP client')
  const saved = new Map((extensionState ? extensionState.read() : []).map(item => [item.extensionId, item]))
  function remember (extensionId, item) {
    const next = new Map(saved)
    if (item) next.set(extensionId, item)
    else next.delete(extensionId)
    if (next.size > 200) throw apiError('LIMIT_EXCEEDED', 'Too many saved extensions')
    if (extensionState) extensionState.write([...next.values()])
    saved.clear()
    for (const [id, value] of next) saved.set(id, value)
  }
  async function native (operation = 'list', extensionId, enabled) {
    const scheme = engine === 'edge' ? 'edge' : 'chrome'
    const { tab } = await tabs.newTab({ url: `${scheme}://extensions`, activate: false })
    try {
      const expression = `(${nativeExtensions.toString()})(${JSON.stringify(operation)},${JSON.stringify(extensionId || '')},${!!enabled})`
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await tabs.send(tab.tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) throw apiError('EXTENSION_REJECTED', 'The browser rejected the extension operation; check its extension settings and policy')
        const value = result.result && result.result.value
        if (value) {
          if (value.error === 'NOT_FOUND') throw apiError('INVALID_REQUEST', 'Extension not found')
          if (value.error === 'POLICY') throw apiError('POLICY_DENIED', 'This extension is managed by the browser or administrator')
          if (value.error) throw apiError('EXTENSION_REJECTED', 'The browser did not apply the extension change')
          return value
        }
        await sleep(100)
      }
      throw apiError('CAPABILITY_MISSING', 'Native extension management is not available in this browser')
    } finally { await tabs.close(tab.tabId) }
  }

  function savedInfo (item) {
    const manifest = readManifest(resolveDir({ stagedId: item.stagedId }), fsApi)
    return {
      extensionId: item.extensionId,
      name: String(manifest.name).slice(0, 100),
      version: String(manifest.version || ''),
      enabled: false,
      installed: false,
      manifestVersion: 3,
      installType: 'unpacked',
      mayModify: true,
      mayRemove: true,
      permissions: (manifest.permissions || []).filter(p => typeof p === 'string').slice(0, 50),
      hostPermissions: (manifest.host_permissions || []).filter(p => typeof p === 'string').slice(0, 50)
    }
  }

  async function get (extensionId) {
    if (!/^[a-p]{32}$/.test(extensionId || '')) throw apiError('INVALID_REQUEST', 'Invalid extension id')
    const item = (await native()).extensions.find(e => e.extensionId === extensionId) ||
      (saved.has(extensionId) ? savedInfo(saved.get(extensionId)) : null)
    if (!item) throw apiError('INVALID_REQUEST', 'Extension not found')
    return item
  }

  async function load (dir) {
    const manifest = readManifest(dir, fsApi)
    walkDir(dir, fsApi)
    let res
    try {
      res = await client.send('Extensions.loadUnpacked', { path: dir })
    } catch (e) {
      const msg = String((e && e.message) || '')
      if (/wasn't found|not found|not allowed|unsafe|method/i.test(msg)) {
        throw apiError('CAPABILITY_MISSING', 'Extensions.loadUnpacked is not available in this browser')
      }
      throw apiError('EXTENSION_REJECTED', 'Extension could not be loaded: ' + msg.slice(0, 120))
    }
    const extensionId = res && res.id
    if (!/^[a-p]{32}$/.test(extensionId || '')) throw apiError('INTERNAL', 'Browser returned no extension id')
    const record = await get(extensionId)
    return { ...record, manifestVersion: manifest.manifest_version }
  }

  function resolveDir (source) {
    if (typeof resolveSource !== 'function') throw apiError('CAPABILITY_MISSING', 'No extension source is configured')
    if (!source || (source.sha256 !== undefined) || (!source.catalogId && !source.stagedId)) {
      throw apiError('CAPABILITY_MISSING', 'Only unpacked extensions from a staged folder or the catalog are supported')
    }
    const dir = resolveSource(source)
    if (!dir) throw apiError('INVALID_REQUEST', 'Unknown extension source')
    return dir
  }

  async function running () {
    const { targetInfos } = await client.send('Target.getTargets', {})
    const ids = new Set()
    for (const t of targetInfos || []) {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || '')
      if (m) ids.add(m[1])
    }
    return ids
  }

  async function setEnabled (extensionId, enabled) {
    const current = await get(extensionId)
    if (enabled && current.installed === false) {
      const loaded = await load(resolveDir({ stagedId: saved.get(extensionId).stagedId }))
      if (loaded.extensionId !== extensionId) throw apiError('EXTENSION_REJECTED', 'Saved extension identity changed')
    } else if (current.installed !== false) {
      await native('setEnabled', extensionId, enabled)
    }
    if (saved.has(extensionId)) {
      remember(extensionId, { ...saved.get(extensionId), enabled })
    }
    return { extension: await get(extensionId) }
  }

  return {
    async restore () {
      if (!saved.size) return
      const { extensions } = await native()
      for (const item of saved.values()) {
        if (!item.enabled || extensions.some(e => e.extensionId === item.extensionId)) continue
        const loaded = await load(resolveDir({ stagedId: item.stagedId }))
        if (loaded.extensionId !== item.extensionId) throw apiError('EXTENSION_REJECTED', 'Saved extension identity changed')
      }
    },
    async list () {
      const result = await native()
      for (const item of saved.values()) {
        if (!result.extensions.some(e => e.extensionId === item.extensionId)) result.extensions.push(savedInfo(item))
      }
      return { ...result, running: [...await running()] }
    },
    async install ({ source }) {
      const r = await load(resolveDir(source))
      if (source.stagedId) {
        remember(r.extensionId, { extensionId: r.extensionId, stagedId: source.stagedId, enabled: true })
      }
      return { extension: r, method: 'cdp.loadUnpacked', restartRequired: false }
    },
    async disable (extensionId) {
      return setEnabled(extensionId, false)
    },
    async enable (extensionId) {
      return setEnabled(extensionId, true)
    },
    async remove (extensionId) {
      const r = await get(extensionId)
      if (!r.mayModify) throw apiError('POLICY_DENIED', 'This extension is managed by the browser or administrator')
      if (!r.mayRemove) throw apiError('CAPABILITY_MISSING', 'Remove store extensions through the browser native extensions page')
      if (r.installed !== false) await client.send('Extensions.uninstall', { id: extensionId })
      if ((await native()).extensions.some(e => e.extensionId === extensionId)) throw apiError('EXTENSION_REJECTED', 'The browser did not remove the extension')
      remember(extensionId, null)
      return { removed: true }
    },

    async setDevMode (enabled) {
      const policy = readDevModePolicy(engine)
      if (policy === 'disallow') {
        if (enabled) throw apiError('POLICY_DENIED', 'Developer mode is disabled by administrator policy')
        return { enabled: false, method: 'policy', restartRequired: false }
      }
      if (!devModeUi) throw apiError('CAPABILITY_MISSING', 'The developer mode toggle is not supported for this browser')
      const scheme = engine === 'edge' ? 'edge' : 'chrome'
      const created = await tabs.newTab({ url: `${scheme}://extensions`, activate: false })
      const tabId = created.tab.tabId
      try {
        let value = null
        for (let i = 0; i < 30 && value === null; i++) {
          await sleep(150)
          const r = await tabs.send(tabId, 'Runtime.evaluate', { expression: DEV_MODE_TOGGLE(enabled), returnByValue: true })
          value = r && r.result ? r.result.value : null
        }
        if (value === null) throw apiError('CAPABILITY_MISSING', 'The developer mode toggle was not found on the extensions page')
        await sleep(200)
        const check = await tabs.send(tabId, 'Runtime.evaluate', { expression: DEV_MODE_TOGGLE(null), returnByValue: true })
        const now = check && check.result ? check.result.value : value
        if (now !== !!enabled) throw apiError('INTERNAL', 'Developer mode did not change')
        return { enabled: now, method: 'ui-toggle', restartRequired: false }
      } finally {
        try { await tabs.close(tabId) } catch {}
      }
    }
  }
}

// Reads ExtensionDeveloperModeSettings (0 = allowed, 1 = disallowed) from the
// machine/user policy hives. Read-only; never writes policy.
function createDevModePolicyReader ({ execFileSync, platform = process.platform } = {}) {
  return function readDevModePolicy (engine) {
    if (platform !== 'win32' || typeof execFileSync !== 'function') return undefined
    const key = engine === 'edge' ? 'SOFTWARE\\Policies\\Microsoft\\Edge' : 'SOFTWARE\\Policies\\Google\\Chrome'
    for (const hive of ['HKLM', 'HKCU']) {
      try {
        const out = String(execFileSync('reg', ['query', `${hive}\\${key}`, '/v', 'ExtensionDeveloperModeSettings'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }))
        const m = /ExtensionDeveloperModeSettings\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)
        if (m) return parseInt(m[1], 16) === 1 ? 'disallow' : 'allow'
      } catch {}
    }
    return undefined
  }
}

module.exports = { createExtensionManager, createExtensionStateStore, createDevModePolicyReader, readManifest }
