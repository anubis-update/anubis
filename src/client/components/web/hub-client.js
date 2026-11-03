// Thin adapter between the Browser Hub UI and the backend. EVERY hub call goes
// through call(); wiring the real IPC (docs/IPC-browserHub.md) is a one-file
// change: set TRANSPORT below or call setTransport(fn) at startup.
// Plain CJS like browser-profile.js so it can be unit tested directly.

const MOCK_SEED = () => ({
  profiles: [
    { profileId: 'prof_default', engine: 'chrome', displayName: 'Default', directoryName: 'Default', accountHint: 'a***@gmail.com', isDefault: true, inUse: false, source: 'system' },
    { profileId: 'prof_work', engine: 'chrome', displayName: 'Work', directoryName: 'Profile 1', isDefault: false, inUse: true, source: 'anubis' }
  ],
  selectedProfile: 'prof_default',
  tabs: [{ tabId: 'tab_1', url: 'about:blank', title: 'New tab', active: true }],
  extensions: [],
  devMode: false,
  history: [
    { url: 'https://example.com/', title: 'Example Domain', lastVisitTime: '2026-01-01T10:00:00Z', visitCount: 3 }
  ],
  cookies: [],
  api: { enabled: false, tokens: [], policy: null },
  audit: [],
  seq: 1
})

let state = MOCK_SEED()
let transport = null

function setTransport (fn) {
  transport = typeof fn === 'function' ? fn : null
}

function isMock () {
  return !transport
}

function resetMock () {
  state = MOCK_SEED()
}

function nextId (prefix) {
  state.seq += 1
  return prefix + '_' + state.seq
}

function audit (command, ok = true) {
  state.audit.unshift({
    id: nextId('aud'),
    ts: new Date().toISOString(),
    actor: { kind: 'human-local', id: 'ui' },
    command,
    decision: { effect: 'allow', rule: 'ui' },
    outcome: { ok }
  })
}

// Default policy mirrors the "default-deny" list of SPEC-v1 7.3
function defaultPolicy () {
  const { DEFAULT_DENY } = require('./hub-policy')
  return {
    version: 1,
    defaultEffect: 'deny',
    roles: {
      agent: { firstMatchWins: true, rules: DEFAULT_DENY.map(c => ({ command: c, effect: 'deny' })) }
    }
  }
}

const mockHandlers = {
  'profile.list': () => ({ profiles: state.profiles, selected: state.selectedProfile }),
  'profile.select': ({ profileId }) => {
    const p = state.profiles.find(x => x.profileId === profileId)
    if (!p) throw hubError('NOT_FOUND', 'Unknown profile')
    state.selectedProfile = profileId
    return { selected: p }
  },
  'tab.list': () => ({ tabs: state.tabs, activeTabId: (state.tabs.find(t => t.active) || {}).tabId }),
  'tab.new': ({ url = 'about:blank' }) => {
    state.tabs.forEach(t => { t.active = false })
    const tab = { tabId: nextId('tab'), url, title: url, active: true }
    state.tabs.push(tab)
    return tab
  },
  'tab.activate': ({ tabId }) => {
    state.tabs.forEach(t => { t.active = t.tabId === tabId })
    return { ok: true }
  },
  'tab.close': ({ tabId }) => {
    state.tabs = state.tabs.filter(t => t.tabId !== tabId)
    if (state.tabs.length && !state.tabs.some(t => t.active)) state.tabs[0].active = true
    return { ok: true }
  },
  'extension.list': () => ({ extensions: state.extensions, devMode: state.devMode }),
  'extension.install': ({ source = 'unpacked', path }) => {
    if (!path) throw hubError('INVALID_PARAMS', 'path required')
    const name = String(path).split(/[\\/]/).filter(Boolean).pop()
    const ext = { extensionId: nextId('ext'), name, version: '0.0.0', enabled: false, installType: source, manifestVersion: 3 }
    state.extensions.push(ext)
    return ext
  },
  'extension.enable': ({ extensionId }) => setExt(extensionId, true),
  'extension.disable': ({ extensionId }) => setExt(extensionId, false),
  'extension.remove': ({ extensionId }) => {
    state.extensions = state.extensions.filter(e => e.extensionId !== extensionId)
    return { ok: true }
  },
  'devMode.set': ({ enabled }) => {
    state.devMode = !!enabled
    return { devMode: state.devMode }
  },
  'history.list': ({ limit = 100 }) => ({ items: state.history.slice(0, limit) }),
  'history.search': ({ query = '', limit = 100 }) => {
    const q = String(query).toLowerCase()
    return {
      items: state.history.filter(h => (h.url + ' ' + (h.title || '')).toLowerCase().includes(q)).slice(0, limit)
    }
  },
  'history.clear': () => {
    state.history = []
    return { ok: true }
  },
  'cookies.export': () => ({ cookies: state.cookies }),
  'cookies.import': ({ cookies }) => {
    state.cookies = state.cookies.concat(cookies)
    return { imported: cookies.length }
  },
  'passwords.export': () => ({ passwords: [] }),
  'passwords.import': ({ passwords }) => ({ imported: passwords.length }),
  'api.settings.get': () => ({ ...state.api, policy: state.api.policy || defaultPolicy() }),
  'api.settings.set': ({ enabled }) => {
    state.api.enabled = !!enabled
    return { enabled: state.api.enabled }
  },
  'api.token.create': ({ label = 'token', role = 'agent' }) => {
    const secret = 'anb_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    const tok = { tokenId: nextId('tok'), label, role, createdAt: new Date().toISOString() }
    state.api.tokens.push(tok)
    return { ...tok, token: secret }
  },
  'api.token.list': () => ({ tokens: state.api.tokens }),
  'api.token.revoke': ({ tokenId }) => {
    state.api.tokens = state.api.tokens.filter(t => t.tokenId !== tokenId)
    return { ok: true }
  },
  'api.policy.get': () => ({ policy: state.api.policy || defaultPolicy() }),
  'api.policy.set': ({ policy }) => {
    state.api.policy = policy
    return { policy }
  },
  'api.audit.list': ({ limit = 200 }) => ({ entries: state.audit.slice(0, limit) })
}

function setExt (extensionId, enabled) {
  const e = state.extensions.find(x => x.extensionId === extensionId)
  if (!e) throw hubError('NOT_FOUND', 'Unknown extension')
  e.enabled = enabled
  return e
}

function hubError (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

async function call (command, params = {}) {
  if (transport) return transport(command, params)
  const h = mockHandlers[command]
  if (!h) throw hubError('NOT_IMPLEMENTED', 'No mock for ' + command)
  const res = h(params)
  audit(command)
  return res
}

module.exports = { call, setTransport, isMock, resetMock }
