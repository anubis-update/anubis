/**
 * Command handlers: map registry command names to driver calls. Everything
 * here runs AFTER the dispatcher's validation/policy/lease checks. Commands
 * the build cannot serve (passwords import/export, crx installs, credentials)
 * throw CAPABILITY_MISSING with a reason.
 */

const { apiError } = require('./errors')

const ok = (extra = {}) => ({ ok: true, snapshotInvalidated: true, ...extra })

function trimSnapshot (snap, maxBytes) {
  if (!maxBytes) return snap
  let nodes = snap.nodes
  let tree = snap.tree
  let truncated = snap.truncated
  const size = () => Buffer.byteLength(JSON.stringify({ nodes, tree }))
  while (size() > maxBytes && nodes.length > 1) {
    nodes = nodes.slice(0, Math.floor(nodes.length * 0.8))
    tree = tree.split('\n').slice(0, nodes.length).join('\n')
    truncated = true
  }
  return { ...snap, nodes, tree, truncated }
}

function createHandlers ({ hub, policy, leases, deviceInfo = () => ({}), staging, vault }) {
  const target = (t) => {
    if (t && t.ref) return { ref: t.ref, snapshotId: t.snapshotId }
    if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) return { x: t.x, y: t.y }
    throw apiError('INVALID_REQUEST', 'target needs a ref or x/y coordinates')
  }
  const needStaging = () => {
    if (!staging) throw apiError('CAPABILITY_MISSING', 'Staging area is not configured')
    return staging
  }
  const allowInstall = () => {
    if (!(policy.extensions && policy.extensions().allowInstall === true)) {
      throw apiError('POLICY_DENIED', 'Extension installation is disabled by policy')
    }
  }
  const PW_REASON = 'Browser password import/export opens native file dialogs that this build cannot drive'

  const nav = (kind) => async ({ driver, tabId, params }) => {
    const r = await driver.navigate(tabId, kind, { url: params.url, waitUntil: params.waitUntil, ignoreCache: params.ignoreCache, timeoutMs: 15000 })
    return { ok: true, navigated: true, url: r.url, title: r.title, loaded: r.loaded, snapshotInvalidated: true }
  }

  return {
    'api.capabilities' () {
      const limits = policy.limits()
      const info = deviceInfo()
      const installed = new Map((info.engines || []).map((e) => [e.engine, e]))
      const engines = hub.drivers().map((d) => ({ engine: d.engine, installed: d.engine === 'rbi' ? true : !!(installed.get(d.engine) || { installed: true }).installed, capabilities: [...d.capabilities()] }))
      const available = new Set(hub.drivers().flatMap((d) => [...d.capabilities()]))
      return {
        apiVersion: 1,
        deviceId: info.deviceId || 'device',
        anubisVersion: info.anubisVersion || '0',
        engines,
        commands: (info.registry || []).map((c) => ({
          name: c.name,
          available: (c.requires || []).every((r) => available.has(r)),
          ...((c.requires || []).every((r) => available.has(r)) ? {} : { reason: 'capability not available' })
        })),
        limits: {
          maxBrowsers: limits.maxBrowsers,
          maxTabsPerBrowser: limits.maxTabsPerBrowser,
          maxSnapshotBytes: limits.maxSnapshotBytes,
          maxCommandsPerMinute: limits.maxCommandsPerMinute
        }
      }
    },

    'browser.list' () {
      return { browsers: hub.allBrowsers() }
    },
    async 'browser.launch' ({ params, driver }) {
      return driver.launch({ ...params, url: params.url })
    },
    async 'browser.close' ({ browserId, driver }) {
      return driver.closeBrowser(browserId)
    },

    'profile.list' ({ driver }) {
      const r = driver.profiles()
      return { profiles: r.profiles, available: r.available }
    },
    'profile.select' ({ params, driver }) {
      for (const d of [driver, ...hub.drivers()]) {
        if (typeof d.selectProfile !== 'function') continue
        try { return d.selectProfile(params.profileId) } catch (e) { if (e.code !== 'PROFILE_NOT_FOUND') throw e }
      }
      throw apiError('PROFILE_NOT_FOUND', 'Profile not found')
    },

    'tab.list' ({ driver, browserId, params }) {
      return driver.listTabs(browserId, { includeInternal: !!params.includeInternal })
    },
    'tab.new' ({ driver, browserId, params }) {
      return driver.newTab(browserId, { url: params.url, activate: params.background ? false : params.activate !== false })
    },
    'tab.activate' ({ driver, tabId }) { return driver.activateTab(tabId) },
    'tab.close' ({ driver, tabId }) { return driver.closeTab(tabId) },
    'tab.reload': nav('reload'),
    'tab.back': nav('back'),
    'tab.forward': nav('forward'),
    'tab.goto': nav('goto'),

    async 'page.snapshot' ({ driver, tabId, params }) {
      const limits = policy.limits()
      const maxBytes = Math.min(params.maxBytes || limits.maxSnapshotBytes, limits.maxSnapshotBytes)
      const snap = await driver.page(tabId).snapshot(tabId, { interestingOnly: params.interestingOnly !== false })
      const out = trimSnapshot(snap, maxBytes)
      if (params.withScreenshot) {
        out.screenshot = await driver.page(tabId).screenshot(tabId, { format: 'jpeg', quality: 60 })
      }
      return out
    },
    async 'page.screenshot' ({ driver, tabId, params }) {
      const shot = await driver.page(tabId).screenshot(tabId, params)
      if (shot.data.length > policy.limits().maxScreenshotBytes * 1.4) throw apiError('LIMIT_EXCEEDED', 'Screenshot exceeds maxScreenshotBytes')
      return shot
    },
    async 'page.click' ({ driver, tabId, params }) {
      await driver.page(tabId).click(tabId, { ...target(params.target), button: params.button, clickCount: params.clickCount })
      return ok()
    },
    async 'page.type' ({ driver, tabId, params }) {
      await driver.page(tabId).type(tabId, { ...target(params.target), text: params.text, clear: params.clear, submit: params.submit })
      return ok()
    },
    async 'page.press' ({ driver, tabId, params }) {
      await driver.page(tabId).press(tabId, { key: params.key })
      return ok()
    },
    async 'page.scroll' ({ driver, tabId, params }) {
      await driver.page(tabId).scroll(tabId, { ...(params.target ? target(params.target) : {}), deltaX: params.dx || 0, deltaY: params.dy || 0 })
      return ok()
    },
    async 'page.hover' ({ driver, tabId, params }) {
      await driver.page(tabId).hover(tabId, target(params.target))
      return ok()
    },
    async 'page.select' ({ driver, tabId, params }) {
      const r = await driver.page(tabId).select(tabId, { ...target(params.target), values: params.values })
      return ok({ selected: r && r.selected })
    },
    async 'page.upload' ({ driver, tabId, params }) {
      const files = needStaging().resolveFiles(params.files)
      const r = await driver.page(tabId).upload(tabId, { ...target(params.target), files })
      return ok({ uploaded: r && r.uploaded })
    },
    async 'page.wait' ({ driver, tabId, params }) {
      await driver.page(tabId).wait(tabId, { text: params.text, selector: params.selector, timeoutMs: params.timeoutMs })
      return { ok: true }
    },
    async 'page.extract' ({ driver, tabId, params }) {
      const limits = policy.limits()
      return driver.page(tabId).extract(tabId, { ref: params.scopeRef, maxChars: Math.min(params.maxBytes || limits.maxSnapshotBytes, limits.maxSnapshotBytes) })
    },
    async 'page.evaluate' ({ driver, tabId, params }) {
      return driver.page(tabId).evaluate(tabId, { expression: params.expression })
    },

    async 'cookies.export' ({ driver, browserId, params }) {
      if (params.mode === 'file') throw apiError('CAPABILITY_MISSING', 'Encrypted cookie export is not available in this build')
      const list = await driver.cookies(browserId, { domains: params.domains })
      const withValues = params.mode === 'values'
      return {
        count: list.length,
        cookies: list.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          ...(c.expires > 0 ? { expires: c.expires } : {}),
          ...(withValues ? { value: c.value } : {})
        }))
      }
    },
    async 'cookies.import' ({ driver, browserId, params }) {
      if (params.artifactId) throw apiError('CAPABILITY_MISSING', 'Artifact imports are not available in this build')
      return driver.setCookies(browserId, params.cookies || [])
    },

    async 'history.list' ({ driver, browserId, params }) {
      const r = await driver.history(browserId, { limit: params.limit, since: params.since, until: params.until })
      return { entries: r.entries, untrusted: true }
    },
    async 'history.search' ({ driver, browserId, params }) {
      const r = await driver.history(browserId, { text: params.query, limit: params.limit })
      return { entries: r.entries, untrusted: true }
    },
    async 'history.clear' ({ driver, browserId, params }) {
      return driver.clearHistory(browserId, { since: params.since, until: params.until })
    },

    'downloads.list' ({ driver, browserId, params }) {
      return driver.downloads(browserId, { limit: params.limit })
    },

    'storage.get' ({ driver, tabId, params }) {
      return driver.storage(tabId).get(tabId, { kind: params.kind, keys: params.keys })
    },
    'storage.set' ({ driver, tabId, params }) {
      return driver.storage(tabId).set(tabId, { kind: params.kind, entries: params.entries })
    },
    'storage.clear' ({ driver, tabId, params }) {
      const v = policy.checkUrl(params.origin)
      if (!v.ok) throw apiError('POLICY_DENIED', v.reason || 'Origin is not allowed')
      return driver.storage(tabId).clear(tabId, { origin: params.origin, types: params.types })
    },

    'extension.list' ({ driver, browserId }) {
      return driver.extensionsOf(browserId).list()
    },
    async 'extension.install' ({ driver, browserId, params }) {
      allowInstall()
      const s = params.source || {}
      if (s.type === 'crx') throw apiError('CAPABILITY_MISSING', 'Packed (.crx) extensions are not supported; use an unpacked MV3 folder')
      if (s.type === 'unpacked') {
        needStaging().resolveDir(s.stagedId)
        return driver.extensionsOf(browserId).install({ source: { stagedId: s.stagedId } })
      }
      if (s.type === 'catalog') return driver.extensionsOf(browserId).install({ source: { catalogId: s.catalogId } })
      throw apiError('INVALID_REQUEST', 'Unknown extension source')
    },
    async 'extension.enable' ({ driver, browserId, params }) {
      allowInstall()
      return driver.extensionsOf(browserId).enable(params.extensionId)
    },
    'extension.disable' ({ driver, browserId, params }) {
      return driver.extensionsOf(browserId).disable(params.extensionId)
    },
    async 'extension.remove' ({ driver, browserId, params }) {
      return driver.extensionsOf(browserId).remove(params.extensionId)
    },
    'devMode.set' ({ driver, browserId, params }) {
      return driver.extensionsOf(browserId).setDevMode(params.enabled)
    },

    async 'passwords.import' ({ params }) {
      if (vault && staging) vault.inspectStaged(staging.resolveFile(params.stagedId).path)
      throw apiError('CAPABILITY_MISSING', PW_REASON)
    },
    'passwords.export' () {
      throw apiError('CAPABILITY_MISSING', PW_REASON)
    },

    'lease.acquire' ({ actor, browserId, params }) {
      if (!browserId) throw apiError('INVALID_REQUEST', 'browserId is required to acquire a lease')
      return leases.acquire({ browserId, actor: actor.id, ttlMs: params.ttlMs, scope: params.scope })
    },
    'lease.release' ({ actor, params }) {
      return leases.release(params.leaseId, actor.id)
    }
  }
}

module.exports = { createHandlers, trimSnapshot }
