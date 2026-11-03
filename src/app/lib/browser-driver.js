/**
 * BrowserDriver abstraction (SPEC-v1 §4, FEASIBILITY B): one driver per engine
 * family manages N browsers, each with N tabs. Drivers declare capabilities;
 * the command registry maps `requires` onto them.
 *
 * Contract (every driver): engine, capabilities(), listBrowsers(), launch(),
 * closeBrowser(), listTabs(), newTab(), activateTab(), closeTab(), navigate(),
 * page(tabId) -> page actions, cookies*(), history*(), profiles().
 * The RBI driver is an intentionally empty stub: RBI keeps its own protocol.
 */

const crypto = require('node:crypto')
const path = require('node:path')
const { apiError } = require('./browser-api/errors')
const { createTabManager } = require('./cdp-tabs')
const { createPageDriver } = require('./cdp-ax')

const CAPS = Object.freeze({
  TABS: 'tabs',
  SNAPSHOT: 'page.snapshot',
  SCREENSHOT: 'page.screenshot',
  INPUT: 'page.input',
  EVALUATE: 'page.evaluate',
  COOKIES: 'cookies',
  HISTORY: 'history',
  PROFILES: 'profile.enumerate',
  LAUNCH: 'browser.launch'
})

const CONTRACT = ['capabilities', 'listBrowsers', 'launch', 'closeBrowser', 'listTabs', 'newTab', 'activateTab', 'closeTab', 'navigate', 'page']

function assertDriver (driver) {
  for (const m of CONTRACT) {
    if (typeof driver[m] !== 'function') throw new TypeError(`BrowserDriver is missing ${m}()`)
  }
  return driver
}

function createRbiDriver () {
  const unsupported = () => { throw apiError('NOT_SUPPORTED_BY_ENGINE', 'The RBI engine does not support the Browser API') }
  return assertDriver({
    engine: 'rbi',
    capabilities: () => new Set(),
    listBrowsers: () => [],
    launch: unsupported,
    closeBrowser: unsupported,
    listTabs: unsupported,
    newTab: unsupported,
    activateTab: unsupported,
    closeTab: unsupported,
    navigate: unsupported,
    page: unsupported,
    owns: () => false
  })
}

function createCdpDriver ({
  engine = 'chrome',
  launchBrowser,
  catalog,
  historyReader,
  getLimits = () => ({}),
  emit = () => {},
  idGen = (p) => p + crypto.randomBytes(6).toString('hex'),
  makeTabs = createTabManager,
  makePage = createPageDriver,
  allowedFlags = ['--lang', '--window-size', '--user-agent', '--disable-gpu', '--mute-audio']
} = {}) {
  if (typeof launchBrowser !== 'function') throw new TypeError('cdp driver requires launchBrowser')
  const browsers = new Map() // browserId -> { handle, tabs, page, profileId, headless }
  const tabOwner = new Map() // tabId -> browserId
  const capSet = new Set([CAPS.TABS, CAPS.SNAPSHOT, CAPS.SCREENSHOT, CAPS.INPUT, CAPS.EVALUATE, CAPS.COOKIES, CAPS.LAUNCH])
  if (catalog) capSet.add(CAPS.PROFILES)
  if (historyReader && historyReader.available) capSet.add(CAPS.HISTORY)

  function entry (browserId) {
    const b = browsers.get(browserId)
    if (!b) throw apiError('BROWSER_NOT_FOUND', 'Browser not found')
    return b
  }

  function ownerOfTab (tabId) {
    const id = tabOwner.get(tabId)
    if (!id || !browsers.has(id)) {
      // A tab can be created by the page itself; look it up in every manager.
      for (const [bid, b] of browsers) if (b.tabs.has(tabId)) { tabOwner.set(tabId, bid); return browsers.get(bid) }
      throw apiError('TAB_NOT_FOUND', 'Tab not found')
    }
    return browsers.get(id)
  }

  function sanitizeFlags (flags = []) {
    return flags.filter((f) => typeof f === 'string' && allowedFlags.some((a) => f === a || f.startsWith(a + '='))).slice(0, 10)
  }

  async function launch ({ profileId, profileMode = 'dedicated', headless = false, extensions, flags, window: win, url, devMode } = {}) {
    if (extensions && extensions.length) throw apiError('CAPABILITY_MISSING', 'Extensions are not supported in this build')
    if (devMode) throw apiError('CAPABILITY_MISSING', 'devMode is not supported in this build')
    const limits = getLimits()
    if (browsers.size >= (limits.maxBrowsers || 2)) throw apiError('LIMIT_EXCEEDED', 'maxBrowsers reached')
    let profileDirectory
    if (profileId) {
      const p = catalog && catalog.resolve(profileId)
      if (!p || p.engine !== engine) throw apiError('PROFILE_NOT_FOUND', 'Profile not found')
      profileDirectory = p.dir
    } else if (catalog && catalog.selected(engine)) {
      const p = catalog.resolve(catalog.selected(engine))
      if (p) { profileId = catalog.selected(engine); profileDirectory = p.dir }
    }
    for (const b of browsers.values()) {
      if (profileMode !== 'ephemeral' && b.profileId === (profileId || 'default') && b.profileMode === profileMode) {
        throw apiError('BROWSER_ALREADY_RUNNING', 'A browser is already running for this profile')
      }
    }
    const browserId = idGen('b_')
    const handle = await launchBrowser({
      id: browserId,
      browser: engine,
      profileMode,
      profileId,
      profileDirectory,
      headless,
      url,
      width: win && win.width,
      height: win && win.height,
      extraFlags: sanitizeFlags(flags)
    })
    const tabs = makeTabs({
      client: handle.client,
      limits,
      emit: (event, e) => emit(event, { browserId, ...e })
    })
    const page = makePage({ tabs })
    const b = { browserId, handle, tabs, page, profileId: profileId || 'default', profileMode, headless: !!headless }
    browsers.set(browserId, b)
    if (typeof handle.onExit === 'function') {
      handle.onExit(() => {
        if (browsers.get(browserId) === b) {
          browsers.delete(browserId)
          tabs.dispose()
          emit('browser.closed', { browserId, data: { reason: 'exited' } })
        }
      })
    }
    try {
      await tabs.init()
    } catch (e) {
      browsers.delete(browserId)
      try { handle.close() } catch {}
      throw e
    }
    emit('browser.launched', { browserId, data: { engine } })
    return { browserId, engine, profileMode, ...(profileId ? { profileId } : {}), headless: !!headless, warnings: handle.warnings || [] }
  }

  async function closeBrowser (browserId) {
    const b = entry(browserId)
    browsers.delete(browserId)
    b.tabs.dispose()
    try { b.handle.close() } catch {}
    emit('browser.closed', { browserId, data: { reason: 'closed' } })
    return { closed: true }
  }

  function track (browserId, info) {
    tabOwner.set(info.tabId, browserId)
    return { ...info, browserId }
  }

  return assertDriver({
    engine,
    capabilities: () => new Set(capSet),
    owns: (browserId) => browsers.has(browserId),
    ownsTab: (tabId) => { try { ownerOfTab(tabId); return true } catch { return false } },
    browserOf: (tabId) => ownerOfTab(tabId).browserId,
    listBrowsers: () => [...browsers.values()].map((b) => ({
      browserId: b.browserId, engine, profileMode: b.profileMode, headless: b.headless, tabCount: b.tabs.count(), ...(b.profileId !== 'default' ? { profileId: b.profileId } : {})
    })),
    launch,
    closeBrowser,
    listTabs (browserId, opts) {
      const b = entry(browserId)
      const r = b.tabs.list(opts)
      return { tabs: r.tabs.map((t) => track(browserId, t)), ...(r.activeTabId ? { activeTabId: r.activeTabId } : {}) }
    },
    async newTab (browserId, opts) {
      const b = entry(browserId)
      const r = await b.tabs.newTab(opts)
      return { tab: track(browserId, r.tab) }
    },
    activateTab: (tabId) => ownerOfTab(tabId).tabs.activate(tabId),
    async closeTab (tabId) {
      const b = ownerOfTab(tabId)
      const r = await b.tabs.close(tabId)
      b.page.forget(tabId)
      return r
    },
    navigate (tabId, kind, opts = {}) {
      const t = ownerOfTab(tabId).tabs
      if (kind === 'goto') return t.goto(tabId, opts.url, opts)
      if (kind === 'reload') return t.reload(tabId, opts)
      if (kind === 'back') return t.back(tabId, opts)
      if (kind === 'forward') return t.forward(tabId, opts)
      throw apiError('INVALID_REQUEST', 'Unknown navigation kind')
    },
    page: (tabId) => ownerOfTab(tabId).page,
    tabInfo: (tabId) => { const b = ownerOfTab(tabId); return { ...b.tabs.info(tabId), browserId: b.browserId } },

    profiles () {
      if (!catalog) throw apiError('CAPABILITY_MISSING', 'Profile enumeration is not available')
      return catalog.enumerate(engine)
    },
    selectProfile (profileId) {
      if (!catalog || !catalog.select(engine, profileId)) throw apiError('PROFILE_NOT_FOUND', 'Profile not found')
      return { selected: true }
    },

    async cookies (browserId, { domains } = {}) {
      const b = entry(browserId)
      const r = await b.handle.client.send('Storage.getCookies', {})
      let list = (r && r.cookies) || []
      if (domains && domains.length) {
        list = list.filter((c) => domains.some((d) => String(c.domain).replace(/^\./, '') === d.replace(/^\./, '') || String(c.domain).endsWith('.' + d.replace(/^\./, ''))))
      }
      return list
    },
    async setCookies (browserId, cookies) {
      const b = entry(browserId)
      await b.handle.client.send('Storage.setCookies', { cookies })
      return { count: cookies.length }
    },

    history (browserId, query) {
      if (!historyReader || !historyReader.available) throw apiError('CAPABILITY_MISSING', 'History reading is not available')
      const b = entry(browserId)
      const dir = path.join(b.handle.userDataDir, b.handle.profileDirectory || 'Default')
      return historyReader.search({ historyPath: path.join(dir, 'History'), ...query })
    },

    shutdown () {
      for (const id of [...browsers.keys()]) closeBrowser(id).catch(() => {})
    }
  })
}

// Routes commands to the driver owning a browser/tab/engine.
function createDriverHub ({ drivers = [], defaultEngine = 'chrome' } = {}) {
  const list = drivers.map(assertDriver)
  const byEngine = (engine) => list.find((d) => d.engine === engine)

  return {
    drivers: () => list,
    engine: (engine) => {
      const d = byEngine(engine)
      if (!d) throw apiError('NOT_SUPPORTED_BY_ENGINE', 'Engine is not available')
      return d
    },
    forBrowser (browserId) {
      const d = list.find((x) => x.owns && x.owns(browserId))
      if (!d) throw apiError('BROWSER_NOT_FOUND', 'Browser not found')
      return d
    },
    forTab (tabId) {
      const d = list.find((x) => x.ownsTab && x.ownsTab(tabId))
      if (!d) throw apiError('TAB_NOT_FOUND', 'Tab not found')
      return d
    },
    defaultEngine,
    capabilitiesFor (engine) {
      const d = byEngine(engine)
      return d ? [...d.capabilities()] : []
    },
    allBrowsers: () => list.flatMap((d) => d.listBrowsers()),
    shutdown: () => list.forEach((d) => d.shutdown && d.shutdown())
  }
}

module.exports = { CAPS, createCdpDriver, createRbiDriver, createDriverHub, assertDriver }
