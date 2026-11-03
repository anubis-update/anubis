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
const { apiError } = require('./browser-api/errors')

const MAX_FILES = 3000
const MAX_BYTES = 64 * 1024 * 1024

const DEV_MODE_TOGGLE = (want) => `(() => {
  const m = document.querySelector('extensions-manager')
  const t = m && m.shadowRoot && m.shadowRoot.querySelector('extensions-toolbar')
  const tg = t && t.shadowRoot && t.shadowRoot.querySelector('#devMode')
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
  readDevModePolicy = () => undefined,
  devModeUi = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!client) throw new TypeError('cdp-extensions requires a CDP client')
  const records = new Map() // extensionId -> record

  const info = (r) => ({
    extensionId: r.extensionId,
    name: String(r.name).slice(0, 100),
    version: String(r.version || ''),
    enabled: r.enabled,
    manifestVersion: 3,
    installType: 'unpacked',
    permissions: r.permissions,
    hostPermissions: r.hostPermissions
  })

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
    const record = {
      extensionId,
      dir,
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      permissions: (manifest.permissions || []).filter((p) => typeof p === 'string').slice(0, 50),
      hostPermissions: (manifest.host_permissions || []).filter((p) => typeof p === 'string').slice(0, 50)
    }
    records.set(extensionId, record)
    return record
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

  function get (extensionId) {
    const r = records.get(extensionId)
    if (!r) throw apiError('INVALID_REQUEST', 'Extension not found')
    return r
  }

  async function running () {
    try {
      const { targetInfos } = await client.send('Target.getTargets', {})
      const ids = new Set()
      for (const t of targetInfos || []) {
        const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || '')
        if (m) ids.add(m[1])
      }
      return ids
    } catch { return new Set() }
  }

  return {
    list: async () => ({ extensions: [...records.values()].map(info), running: [...await running()] }),
    async install ({ source }) {
      const r = await load(resolveDir(source))
      return { extension: info(r), method: 'cdp.loadUnpacked', restartRequired: false }
    },
    async disable (extensionId) {
      const r = get(extensionId)
      if (r.enabled) await client.send('Extensions.uninstall', { id: extensionId })
      r.enabled = false
      return { extension: info(r) }
    },
    async enable (extensionId) {
      const r = get(extensionId)
      if (!r.enabled) {
        const again = await load(r.dir)
        if (again.extensionId !== extensionId) records.delete(again.extensionId)
        records.set(extensionId, { ...r, enabled: true })
      }
      return { extension: info(records.get(extensionId)) }
    },
    async remove (extensionId) {
      const r = get(extensionId)
      if (r.enabled) await client.send('Extensions.uninstall', { id: extensionId })
      records.delete(extensionId)
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

module.exports = { createExtensionManager, createDevModePolicyReader, readManifest }
