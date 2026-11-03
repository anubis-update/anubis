/**
 * Multi-tab manager for ONE browser over a CDP client (SPEC-v1 §4.3, FEASIBILITY B.4).
 *
 * Browser -> N tabs using Target.* with flatten sessions. The CDP client is the
 * one from cdp-launch.js (`send(method, params, sessionId)` / `on(method, cb,
 * sessionId)`); it is injected so everything runs on fakes. Page sessions are
 * attached lazily and keep ONE permanent listener set per session (the client
 * has no `off`), which feeds per-tab state used by waiters (load / network idle).
 */

const crypto = require('node:crypto')
const { apiError } = require('./browser-api/errors')

const INTERNAL_URL = /^(chrome|edge|devtools|chrome-extension|chrome-untrusted|about|view-source):/i

function newId (prefix) {
  return prefix + crypto.randomBytes(6).toString('hex')
}

function createTabManager ({
  client,
  idGen = newId,
  emit = () => {},
  limits = {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  if (!client) throw new TypeError('cdp-tabs requires a CDP client')
  const tabs = new Map() // tabId -> tab
  const byTarget = new Map() // targetId -> tabId
  const closedIds = new Set()
  const pendingAgent = new Set() // targetIds created through the API
  let activeTabId = null

  const maxTabs = () => limits.maxTabsPerBrowser || 20

  function isInternal (url) {
    return INTERNAL_URL.test(url || '') && url !== 'about:blank'
  }

  function toInfo (tab) {
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      active: tab.tabId === activeTabId,
      loading: tab.loading,
      ...(tab.openerTabId ? { openerTabId: tab.openerTabId } : {}),
      untrusted: true
    }
  }

  function addTarget (info) {
    if (!info || info.type !== 'page' || byTarget.has(info.targetId)) return null
    const tabId = idGen('t_')
    const opener = info.openerId ? byTarget.get(info.openerId) : undefined
    const byAgent = pendingAgent.delete(info.targetId)
    const tab = {
      tabId,
      targetId: info.targetId,
      sessionId: undefined,
      attaching: null,
      url: info.url || '',
      title: info.title || '',
      openerTabId: opener,
      loading: false,
      navCount: 0,
      inflight: 0,
      lastNetworkActivity: now(),
      lifecycle: new Set(),
      waiters: new Set(),
      dialogs: [],
      hooks: new Set()
    }
    tabs.set(tabId, tab)
    byTarget.set(info.targetId, tabId)
    if (activeTabId === null) activeTabId = tabId
    emit('tab.created', { tabId, data: { url: tab.url, ...(opener ? { openerTabId: opener } : {}), byAgent } })
    return tab
  }

  function notify (tab) {
    for (const w of [...tab.waiters]) {
      try { if (w.check()) { tab.waiters.delete(w); w.resolve() } } catch {}
    }
  }

  function bindSessionEvents (tab, sessionId) {
    const on = (method, cb) => client.on(method, cb, sessionId)
    on('Page.frameNavigated', (p) => {
      if (p.frame && !p.frame.parentId) {
        tab.url = p.frame.url || tab.url
        tab.navCount++
        tab.lifecycle.clear()
        tab.inflight = 0
        for (const hook of tab.hooks) { try { hook('navigated') } catch {} }
        emit('tab.navigated', { tabId: tab.tabId, data: { url: tab.url, frameId: p.frame.id } })
        notify(tab)
      }
    })
    on('Page.navigatedWithinDocument', (p) => {
      tab.url = p.url || tab.url
      tab.navCount++
      for (const hook of tab.hooks) { try { hook('navigated') } catch {} }
      emit('tab.navigated', { tabId: tab.tabId, data: { url: tab.url } })
      notify(tab)
    })
    on('Page.lifecycleEvent', (p) => {
      if (p.name) tab.lifecycle.add(p.name)
      if (p.name === 'init') tab.lifecycle.clear()
      notify(tab)
    })
    on('Page.loadEventFired', () => {
      tab.lifecycle.add('load')
      tab.loading = false
      emit('tab.loading', { tabId: tab.tabId, data: { state: 'done' } })
      notify(tab)
    })
    on('Page.domContentEventFired', () => { tab.lifecycle.add('DOMContentLoaded'); notify(tab) })
    on('Page.frameStartedLoading', () => {
      tab.loading = true
      emit('tab.loading', { tabId: tab.tabId, data: { state: 'start' } })
    })
    on('Network.requestWillBeSent', () => { tab.inflight++; tab.lastNetworkActivity = now() })
    const done = () => { tab.inflight = Math.max(0, tab.inflight - 1); tab.lastNetworkActivity = now(); notify(tab) }
    on('Network.loadingFinished', done)
    on('Network.loadingFailed', done)
    // Dialogs would hang the session: close them and surface an event instead.
    on('Page.javascriptDialogOpening', (p) => {
      const accept = p.type === 'beforeunload'
      client.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {})
      tab.dialogs.push({ kind: p.type, message: String(p.message || '').slice(0, 500) })
      if (tab.dialogs.length > 20) tab.dialogs.shift()
      emit('page.dialog', { tabId: tab.tabId, data: { kind: p.type, message: String(p.message || '').slice(0, 500), handled: true } })
    })
    on('Target.detachedFromTarget', () => { tab.sessionId = undefined })
  }

  async function ensureSession (tabId) {
    const tab = tabs.get(tabId)
    if (!tab) throw apiError('TAB_NOT_FOUND', 'Tab not found')
    if (tab.sessionId) return tab.sessionId
    if (!tab.attaching) {
      tab.attaching = (async () => {
        const attached = await client.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
        const sessionId = attached && attached.sessionId
        if (!sessionId) throw apiError('TAB_NOT_FOUND', 'Tab could not be attached')
        if (!tab.bound) {
          bindSessionEvents(tab, sessionId)
          tab.bound = sessionId
        } else if (tab.bound !== sessionId) {
          bindSessionEvents(tab, sessionId)
          tab.bound = sessionId
        }
        await Promise.all([
          client.send('Page.enable', {}, sessionId),
          client.send('DOM.enable', {}, sessionId),
          client.send('Network.enable', {}, sessionId),
          client.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {})
        ])
        tab.sessionId = sessionId
        return sessionId
      })().finally(() => { tab.attaching = null })
    }
    return tab.attaching
  }

  function get (tabId) {
    const tab = tabs.get(tabId)
    if (!tab) throw apiError('TAB_NOT_FOUND', 'Tab not found')
    return tab
  }

  client.on('Target.targetCreated', (p) => { addTarget(p.targetInfo) })
  client.on('Target.targetInfoChanged', (p) => {
    const info = p.targetInfo
    const tabId = info && byTarget.get(info.targetId)
    const tab = tabId && tabs.get(tabId)
    if (!tab) return
    if (info.title !== undefined && info.title !== tab.title) {
      tab.title = info.title
      emit('tab.title', { tabId, data: { title: String(info.title).slice(0, 500) } })
    }
    if (info.url !== undefined && info.url !== tab.url && !tab.sessionId) {
      tab.url = info.url
      emit('tab.navigated', { tabId, data: { url: tab.url } })
    }
  })
  client.on('Target.targetDestroyed', (p) => {
    const tabId = byTarget.get(p.targetId)
    if (!tabId) return
    const tab = tabs.get(tabId)
    byTarget.delete(p.targetId)
    tabs.delete(tabId)
    closedIds.add(tabId)
    if (closedIds.size > 2000) closedIds.delete(closedIds.values().next().value)
    for (const w of tab.waiters) w.reject(apiError('TAB_NOT_FOUND', 'Tab was closed'))
    tab.waiters.clear()
    if (activeTabId === tabId) activeTabId = tabs.size ? tabs.keys().next().value : null
    emit('tab.closed', { tabId, data: {} })
  })
  client.on('Target.targetCrashed', (p) => {
    const tabId = byTarget.get(p.targetId)
    if (tabId) emit('tab.crashed', { tabId, data: {} })
  })

  async function init () {
    await client.send('Target.setDiscoverTargets', { discover: true })
    const res = await client.send('Target.getTargets')
    for (const info of (res && res.targetInfos) || []) addTarget(info)
    return list({ includeInternal: true })
  }

  function list ({ includeInternal = false } = {}) {
    const out = []
    for (const tab of tabs.values()) {
      if (!includeInternal && isInternal(tab.url)) continue
      out.push(toInfo(tab))
    }
    return { tabs: out, ...(activeTabId ? { activeTabId } : {}) }
  }

  async function newTab ({ url, activate = true } = {}) {
    if (tabs.size >= maxTabs()) throw apiError('LIMIT_EXCEEDED', 'maxTabsPerBrowser reached')
    const created = await client.send('Target.createTarget', { url: url || 'about:blank', background: !activate })
    const targetId = created && created.targetId
    if (!targetId) throw apiError('INTERNAL', 'Tab was not created')
    pendingAgent.add(targetId)
    let tab = tabs.get(byTarget.get(targetId))
    if (!tab) {
      // targetCreated can arrive after the createTarget response
      for (let i = 0; i < 20 && !byTarget.has(targetId); i++) await sleep(25)
      tab = tabs.get(byTarget.get(targetId))
    }
    if (!tab) {
      tab = addTarget({ type: 'page', targetId, url: url || 'about:blank' })
    }
    pendingAgent.delete(targetId)
    if (activate) {
      await client.send('Target.activateTarget', { targetId }).catch(() => {})
      setActive(tab.tabId)
    }
    return { tab: toInfo(tab) }
  }

  function setActive (tabId) {
    if (activeTabId !== tabId) {
      activeTabId = tabId
      emit('tab.activated', { tabId, data: {} })
    }
  }

  async function activate (tabId) {
    const tab = get(tabId)
    await client.send('Target.activateTarget', { targetId: tab.targetId })
    setActive(tabId)
    return { tab: toInfo(tab) }
  }

  async function close (tabId) {
    if (!tabs.has(tabId)) {
      if (closedIds.has(tabId)) return { closed: false }
      throw apiError('TAB_NOT_FOUND', 'Tab not found')
    }
    const tab = tabs.get(tabId)
    await client.send('Target.closeTarget', { targetId: tab.targetId })
    // targetDestroyed removes it; make closing deterministic if the event lags
    for (let i = 0; i < 20 && tabs.has(tabId); i++) await sleep(10)
    return { closed: true }
  }

  function waitFor (tab, check, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (check()) { resolve(); return }
      const waiter = {
        check,
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (e) => { clearTimeout(timer); reject(e) }
      }
      const timer = setTimeout(() => {
        tab.waiters.delete(waiter)
        reject(apiError('TIMEOUT', 'Timed out waiting for the page'))
      }, timeoutMs)
      tab.waiters.add(waiter)
    })
  }

  // waitUntil: load | domcontentloaded | networkidle | none
  async function settle (tab, waitUntil, timeoutMs) {
    if (waitUntil === 'none') return
    const check = waitUntil === 'domcontentloaded'
      ? () => tab.lifecycle.has('DOMContentLoaded') || tab.lifecycle.has('load')
      : waitUntil === 'networkidle'
        ? () => tab.lifecycle.has('load') && tab.inflight === 0 && now() - tab.lastNetworkActivity >= 500
        : () => tab.lifecycle.has('load')
    if (waitUntil === 'networkidle') {
      const start = now()
      while (!check()) {
        if (now() - start > timeoutMs) throw apiError('TIMEOUT', 'Timed out waiting for the page')
        await sleep(100)
      }
      return
    }
    await waitFor(tab, check, timeoutMs)
  }

  async function navResult (tab, status) {
    return { url: tab.url, title: tab.title, loaded: tab.lifecycle.has('load'), ...(status ? { status } : {}) }
  }

  async function goto (tabId, url, { waitUntil = 'load', timeoutMs = 15000 } = {}) {
    const tab = get(tabId)
    const sessionId = await ensureSession(tabId)
    tab.lifecycle.clear()
    const res = await client.send('Page.navigate', { url }, sessionId)
    if (res && res.errorText) throw apiError('NAVIGATION_FAILED', 'Navigation failed: ' + String(res.errorText).slice(0, 100))
    tab.url = url
    await settle(tab, waitUntil, timeoutMs)
    return navResult(tab)
  }

  async function reload (tabId, { ignoreCache = false, waitUntil = 'load', timeoutMs = 15000 } = {}) {
    const tab = get(tabId)
    const sessionId = await ensureSession(tabId)
    tab.lifecycle.clear()
    await client.send('Page.reload', { ignoreCache }, sessionId)
    await settle(tab, waitUntil, timeoutMs)
    return navResult(tab)
  }

  async function history (tabId, delta, { waitUntil = 'load', timeoutMs = 15000 } = {}) {
    const tab = get(tabId)
    const sessionId = await ensureSession(tabId)
    const h = await client.send('Page.getNavigationHistory', {}, sessionId)
    const entry = h && h.entries && h.entries[h.currentIndex + delta]
    if (!entry) throw apiError('NAVIGATION_FAILED', delta < 0 ? 'No previous page' : 'No next page')
    tab.lifecycle.clear()
    await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId)
    await settle(tab, waitUntil, timeoutMs)
    return navResult(tab)
  }

  async function send (tabId, method, params) {
    const sessionId = await ensureSession(tabId)
    return client.send(method, params, sessionId)
  }

  function dispose () {
    for (const tab of tabs.values()) {
      for (const w of tab.waiters) w.reject(apiError('BROWSER_CLOSED', 'Browser closed'))
      tab.waiters.clear()
    }
    tabs.clear()
    byTarget.clear()
  }

  return {
    init,
    list,
    newTab,
    activate,
    close,
    goto,
    reload,
    back: (tabId, opts) => history(tabId, -1, opts),
    forward: (tabId, opts) => history(tabId, 1, opts),
    send,
    ensureSession,
    get,
    has: (tabId) => tabs.has(tabId),
    info: (tabId) => toInfo(get(tabId)),
    count: () => tabs.size,
    waitFor,
    dispose
  }
}

module.exports = { createTabManager, isInternalUrl: (u) => INTERNAL_URL.test(u || '') && u !== 'about:blank' }
