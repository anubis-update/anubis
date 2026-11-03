/**
 * Command handlers: map registry command names to driver calls. Everything
 * here runs AFTER the dispatcher's validation/policy/lease checks. Commands
 * that are declared in the registry but not implemented in this build throw
 * CAPABILITY_MISSING (extensions, devMode, storage, downloads, passwords,
 * credentials, uploads, history.clear, coordinate targets, select).
 */

const { apiError } = require('./errors')

const ok = (extra = {}) => ({ ok: true, snapshotInvalidated: true, ...extra })
const missing = (what) => () => { throw apiError('CAPABILITY_MISSING', what + ' is not available in this build') }

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

function createHandlers ({ hub, policy, leases, deviceInfo = () => ({}) }) {
  const target = (t) => {
    if (!t || !t.ref) throw apiError('CAPABILITY_MISSING', 'Coordinate targets are not available in this build; use a ref from page.snapshot')
    return { ref: t.ref, snapshotId: t.snapshotId }
  }

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
    'page.select': missing('page.select'),
    'page.upload': missing('page.upload'),
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
    'history.clear': missing('history.clear'),

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
