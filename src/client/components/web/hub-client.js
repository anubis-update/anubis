// Adapter between the Browser Hub UI and the main process.
// Real transport: window.pre.runGlobalAsync('browserHub', action, payload)
// (docs/IPC-browserHub.md). Every call resolves to { ok, result | error };
// this module unwraps it and throws Error{code} on failure.
// Mock mode exists ONLY when window.pre is absent (unit tests / storybook).
// Plain CJS like browser-profile.js so it can be unit tested directly.

const EVENT_CHANNEL = 'browserHub:event'

function hubError (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function getPre () {
  const w = typeof window !== 'undefined' ? window : null
  return w && w.pre && typeof w.pre.runGlobalAsync === 'function' ? w.pre : null
}

// ---------------------------------------------------------------- mock

const MOCK_SEED = () => ({
  profiles: [
    { profileId: 'prof_default', engine: 'chrome', displayName: 'Default', directoryName: 'Default', accountHint: 'a***@gmail.com', isDefault: true, inUse: false, source: 'system' },
    { profileId: 'prof_work', engine: 'chrome', displayName: 'Work', directoryName: 'Profile 1', isDefault: false, inUse: true, source: 'system' }
  ],
  browsers: [{ browserId: 'br_1', engine: 'chrome', profileMode: 'dedicated', headless: false, tabCount: 1 }],
  tabs: [{ tabId: 'tab_1', url: 'about:blank', title: 'New tab', active: true }],
  extensions: [],
  history: [
    { url: 'https://example.com/', title: 'Example Domain', lastVisitTime: '2026-01-01T10:00:00Z', visitCount: 3 }
  ],
  tokens: [],
  policy: null,
  staged: {},
  cveRun: null,
  approver: false,
  seq: 1
})

let state = MOCK_SEED()
let forceMock = false

function resetMock () {
  state = MOCK_SEED()
}

function nextId (prefix) {
  state.seq += 1
  return prefix + '_' + state.seq
}

function mockDefaultPolicy () {
  return {
    version: 1,
    defaultEffect: 'deny',
    roles: {
      admin: { firstMatchWins: true, rules: [{ command: '*', effect: 'allow' }] },
      operator: { firstMatchWins: true, rules: [{ command: 'history.clear', effect: 'confirm' }, { command: '*', effect: 'allow' }] },
      agent: {
        firstMatchWins: true,
        rules: [
          { command: 'page.evaluate', effect: 'deny' },
          { command: 'passwords.*', effect: 'deny' },
          { command: 'extension.install', effect: 'deny' },
          { command: '*', effect: 'allow' }
        ]
      }
    },
    extensions: { allowInstall: false }
  }
}

function needExtensionAllowed () {
  const p = state.policy || mockDefaultPolicy()
  if (!(p.extensions && p.extensions.allowInstall)) throw hubError('POLICY_DENIED', 'Extension install is disabled by policy')
}

function setExt (extensionId, enabled) {
  const e = state.extensions.find(x => x.extensionId === extensionId)
  if (!e) throw hubError('INVALID_REQUEST', 'Unknown extension')
  e.enabled = enabled
  return { extension: e }
}

const mockCommands = {
  'browser.list': () => ({ running: state.browsers, installed: [{ engine: 'chrome' }] }),
  'browser.launch': ({ engine = 'chrome', profileId }) => {
    const b = { browserId: nextId('br'), engine, profileMode: 'dedicated', headless: false, tabCount: 1, profileId }
    state.browsers.push(b)
    return { browserId: b.browserId, engine, tabs: [] }
  },
  'browser.close': (p, ctx) => {
    state.browsers = state.browsers.filter(b => b.browserId !== ctx.browserId)
    return { closed: true }
  },
  'profile.list': () => ({ profiles: state.profiles }),
  'profile.select': ({ profileId }) => {
    const p = state.profiles.find(x => x.profileId === profileId)
    if (!p) throw hubError('PROFILE_NOT_FOUND', 'Unknown profile')
    return { selected: p }
  },
  'tab.list': () => ({ tabs: state.tabs, activeTabId: (state.tabs.find(t => t.active) || {}).tabId }),
  'tab.new': ({ url = 'about:blank' }) => {
    state.tabs.forEach(t => { t.active = false })
    const tab = { tabId: nextId('tab'), url, title: url, active: true }
    state.tabs.push(tab)
    return { tab }
  },
  'tab.activate': (p, ctx) => {
    state.tabs.forEach(t => { t.active = t.tabId === ctx.tabId })
    return { tab: state.tabs.find(t => t.tabId === ctx.tabId) }
  },
  'tab.close': (p, ctx) => {
    state.tabs = state.tabs.filter(t => t.tabId !== ctx.tabId)
    if (state.tabs.length && !state.tabs.some(t => t.active)) state.tabs[0].active = true
    return { closed: true }
  },
  'extension.list': () => ({ extensions: state.extensions, running: [] }),
  'extension.install': ({ source }) => {
    needExtensionAllowed()
    if (!source || source.type !== 'unpacked' || !state.staged[source.stagedId]) {
      throw hubError('INVALID_REQUEST', 'source.stagedId required')
    }
    const ext = { extensionId: nextId('ext'), name: state.staged[source.stagedId], version: '0.0.0', enabled: false, installType: 'unpacked', manifestVersion: 3 }
    state.extensions.push(ext)
    return { extension: ext, restartRequired: false }
  },
  'extension.enable': ({ extensionId }) => setExt(extensionId, true),
  'extension.disable': ({ extensionId }) => setExt(extensionId, false),
  'extension.remove': ({ extensionId }) => {
    state.extensions = state.extensions.filter(e => e.extensionId !== extensionId)
    return { removed: true }
  },
  'devMode.set': ({ enabled }) => ({ enabled: !!enabled, method: 'ui-toggle', restartRequired: false }),
  'history.list': ({ limit = 100 }) => ({ items: state.history.slice(0, limit) }),
  'history.search': ({ query = '', limit = 50 }) => {
    const q = String(query).toLowerCase()
    return { items: state.history.filter(h => (h.url + ' ' + (h.title || '')).toLowerCase().includes(q)).slice(0, limit) }
  },
  'history.clear': () => {
    state.history = []
    return { cleared: true }
  }
}

const UI_BLOCKED = ['page.evaluate', 'cookies.export', 'cookies.import', 'credential.fill', 'passwords.import', 'passwords.export']

const mockActions = {
  status: () => ({
    enabled: true,
    engines: [{ engine: 'chrome', capabilities: [] }],
    browsers: state.browsers,
    allowExtensionInstall: !!(state.policy || mockDefaultPolicy()).extensions.allowInstall,
    pendingConfirmations: 0,
    approverRegistered: state.approver,
    stagingRoot: null
  }),
  'policy.get': () => ({ policy: state.policy || mockDefaultPolicy(), defaults: mockDefaultPolicy(), adminLocked: false }),
  'policy.set': ({ policy }) => {
    if (!policy || policy.version !== 1) throw hubError('INVALID_REQUEST', 'invalid policy')
    state.policy = policy
    return { policy }
  },
  'policy.reset': () => {
    state.policy = null
    return { policy: mockDefaultPolicy() }
  },
  'tokens.list': () => ({ tokens: state.tokens }),
  'tokens.issue': ({ role = 'agent', ttlSec = 86400, label } = {}) => {
    if (role !== 'agent' && role !== 'operator') throw hubError('INVALID_REQUEST', 'role must be agent or operator')
    const now = Date.now()
    const info = { id: nextId('tok'), role, ...(label ? { label } : {}), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSec * 1000).toISOString() }
    state.tokens.push(info)
    return { token: 'abt_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), info }
  },
  'tokens.revoke': ({ id }) => {
    const n = state.tokens.length
    state.tokens = state.tokens.filter(t => t.id !== id)
    return { revoked: state.tokens.length < n }
  },
  'confirmations.list': () => ({ items: [] }),
  'confirmations.decide': () => { throw hubError('INVALID_REQUEST', 'Unknown confirmation') },
  'approver.register': () => { state.approver = true; return { registered: true } },
  'approver.unregister': () => { state.approver = false; return { registered: false } },
  'events.subscribe': () => ({ subscribed: true, channel: EVENT_CHANNEL }),
  'events.unsubscribe': () => ({ subscribed: false }),
  'events.since': () => ({ events: [] }),
  'cveScanner.start': () => {
    state.cveRun = {
      runId: 'mock-cve-run',
      state: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      scanners: {
        js: { state: 'done', progress: 'Scan complete', findingsCount: 0, coverage: { status: 'complete', warnings: [] }, error: null },
        python: { state: 'done', progress: 'Scan complete', findingsCount: 0, coverage: null, error: null }
      },
      findings: [],
      error: null
    }
    return state.cveRun
  },
  'cveScanner.get': () => state.cveRun,
  'cveScanner.cancel': () => state.cveRun,
  'staging.import': ({ path }) => {
    if (!path) throw hubError('INVALID_REQUEST', 'path required')
    const stagedId = nextId('stg')
    state.staged[stagedId] = String(path).split(/[\\/]/).filter(Boolean).pop()
    return { stagedId, kind: 'dir', size: 0 }
  },
  'command.execute': ({ command, params = {}, browserId, tabId } = {}) => {
    const reqId = 'ui_mock'
    const fail = (code, message) => ({ v: 1, requestId: reqId, ok: false, error: { code, message } })
    if (UI_BLOCKED.includes(command)) return fail('POLICY_DENIED', 'This command cannot be run from the UI')
    const h = mockCommands[command]
    if (!h) return fail('INVALID_REQUEST', 'Unknown command ' + command)
    try {
      return { v: 1, requestId: reqId, ok: true, result: h(params, { browserId, tabId }), durationMs: 0 }
    } catch (e) {
      return fail(e.code || 'INTERNAL', e.message)
    }
  }
}

// ---------------------------------------------------------------- transport

function isMock () {
  return forceMock || !getPre()
}

// Tests only: force mock mode even if a window.pre stub exists.
function setMock (v) {
  forceMock = !!v
}

// Resolves to the unwrapped action result; throws Error{code} otherwise.
async function ipc (action, payload) {
  let res
  const pre = getPre()
  if (pre && !forceMock) {
    try {
      res = await pre.runGlobalAsync('browserHub', action, payload)
    } catch (e) {
      // Older device installations do not expose the Hub through managed RPC.
      if (/Unsupported managed browser function/i.test(String(e && e.message))) {
        throw hubError('REMOTE_UNSUPPORTED', 'This device runs a version without Browser Hub support. Update Anubis on the device.')
      }
      throw e
    }
  } else {
    const h = mockActions[action]
    if (!h) throw hubError('INVALID_REQUEST', 'Unknown browserHub action')
    try {
      res = { ok: true, result: h(payload) }
    } catch (e) {
      res = { ok: false, error: { code: e.code || 'INTERNAL', message: e.message } }
    }
  }
  if (!res || res.ok !== true) {
    const err = (res && res.error) || {}
    throw hubError(err.code || 'INTERNAL', err.message || 'Browser Hub call failed')
  }
  return res.result
}

async function localCveScanner (action, payload) {
  const pre = getPre()
  if (pre && !forceMock) return pre.runGlobalAsync('cveScanner', action, payload)
  const mockAction = mockActions['cveScanner.' + action]
  if (!mockAction) throw hubError('INVALID_REQUEST', 'Unknown local CVE scanner action')
  return mockAction(payload)
}

// Runs a registry command as the UI admin actor; unwraps the dispatcher envelope.
async function exec (command, params = {}, { browserId, tabId, leaseId } = {}) {
  const env = await ipc('command.execute', {
    command,
    params,
    ...(browserId ? { browserId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(leaseId ? { leaseId } : {})
  })
  if (!env || env.ok !== true) {
    const err = (env && env.error) || {}
    throw hubError(err.code || 'INTERNAL', err.message || command + ' failed')
  }
  return env.result
}

// Subscribes to 'browserHub:event' pushes (after approver.register or events.subscribe).
// Returns an unsubscribe function.
function onEvent (cb, onError = (error) => console.error('Browser Hub events:', error)) {
  const pre = getPre()
  if (!pre || forceMock) return () => {}
  if (typeof window !== 'undefined' && window.et && window.et.isWebApp) {
    let stopped = false
    let seq = 0
    let timer
    let reported = false
    const poll = async () => {
      try {
        const result = await ipc('events.since', { seq })
        if (stopped) return
        for (const event of result.events) {
          if (event.seq <= seq) continue
          seq = event.seq
          cb(event)
        }
        reported = false
      } catch (error) {
        if (!stopped && !reported) { onError(error); reported = true }
      } finally {
        if (!stopped) timer = setTimeout(poll, 750)
      }
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }
  if (typeof pre.ipcOnEvent !== 'function') return () => {}
  // preload passes the raw ipcRenderer listener args: (ipcEvent, payload)
  const handler = (...args) => cb(args.length > 1 ? args[1] : args[0])
  pre.ipcOnEvent(EVENT_CHANNEL, handler)
  return () => {
    if (typeof pre.ipcOffEvent === 'function') pre.ipcOffEvent(EVENT_CHANNEL, handler)
  }
}

function onTabChange (browserId, reload, onError) {
  let timer
  const off = onEvent(ev => {
    if (ev.browserId !== browserId || !ev.event.startsWith('tab.')) return
    clearTimeout(timer)
    timer = setTimeout(reload, 100)
  }, onError)
  return () => { off(); clearTimeout(timer) }
}

module.exports = {
  onTabChange,
  EVENT_CHANNEL,
  ipc,
  localCveScanner,
  exec,
  onEvent,
  isMock,
  setMock,
  resetMock,
  hubError,
  status: () => ipc('status'),
  policyGet: () => ipc('policy.get'),
  policySet: (policy) => ipc('policy.set', { policy }),
  policyReset: () => ipc('policy.reset'),
  tokensList: () => ipc('tokens.list'),
  tokensIssue: (p) => ipc('tokens.issue', p),
  tokensRevoke: (id) => ipc('tokens.revoke', { id }),
  confirmationsList: () => ipc('confirmations.list'),
  confirmationsDecide: (confirmationId, approve) => ipc('confirmations.decide', { confirmationId, approve }),
  approverRegister: () => ipc('approver.register'),
  approverUnregister: () => ipc('approver.unregister'),
  stagingImport: (path) => ipc('staging.import', { path })
}
