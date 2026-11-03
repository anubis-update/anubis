/**
 * browserHub IPC controller (main process). The renderer calls
 * `window.pre.runGlobalAsync('browserHub', action, payload)`; every call
 * resolves to `{ ok: true, result }` or `{ ok: false, error: { code, message } }`
 * and never throws. The confirmation local token never leaves this module.
 * Exact shapes: anubis-browser-api/docs/IPC-browserHub.md
 */

const { apiError } = require('./errors')

const UI_ACTOR = Object.freeze({ id: 'ui', role: 'admin', kind: 'admin' })
const UI_BLOCKED = new Set(['page.evaluate', 'cookies.export', 'cookies.import', 'credential.fill', 'passwords.import', 'passwords.export'])
const TOKEN_ROLES = ['agent', 'operator']
const MIN_TTL_SEC = 60
const MAX_TTL_SEC = 30 * 24 * 3600
const EVENT_CHANNEL = 'browserHub:event'

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function createBrowserHubController ({ api, tokens, send = () => {}, crypto = require('node:crypto'), controlCenter = null } = {}) {
  if (!api || !tokens) throw new TypeError('browserHub controller requires api and tokens')
  let unregister = null
  let unsubscribe = null
  const needObj = (p) => { if (!isObj(p)) throw apiError('INVALID_REQUEST', 'payload must be an object'); return p }

  function startEvents () {
    if (unsubscribe) return
    unsubscribe = api.events.subscribe((ev) => {
      try { send(EVENT_CHANNEL, ev) } catch {}
    })
  }
  function stopEvents () {
    if (unsubscribe) unsubscribe()
    unsubscribe = null
  }

  const needCc = () => {
    if (!controlCenter) throw apiError('DISABLED', 'Control Center channel is disabled')
    return controlCenter
  }

  const actions = {
    'controlCenter.status': () => controlCenter ? controlCenter.status() : { enabled: false, state: 'disabled', enrolled: false },
    'controlCenter.enroll': (p) => needCc().enroll({ token: needObj(p).token, deviceName: p.deviceName }),
    'controlCenter.connect': () => needCc().connect(),
    'controlCenter.disconnect': () => needCc().disconnect(),
    'controlCenter.kill': () => needCc().kill(),
    'controlCenter.resume': () => needCc().resume(),
    'controlCenter.forget': () => needCc().forget(),

    status () {
      return {
        enabled: true,
        engines: api.hub.drivers().filter((d) => d.engine !== 'rbi').map((d) => ({ engine: d.engine, capabilities: [...d.capabilities()].sort() })),
        browsers: api.hub.allBrowsers(),
        allowExtensionInstall: api.policy.extensions().allowInstall === true,
        pendingConfirmations: api.confirmations.list().length,
        approverRegistered: !!unregister,
        controlCenter: controlCenter ? controlCenter.status() : { enabled: false, state: 'disabled' },
        stagingRoot: api.staging ? api.staging.root() : null
      }
    },

    'policy.get': () => api.policyStore.get(),
    'policy.set': (p) => api.policyStore.set(needObj(p).policy),
    'policy.reset': () => api.policyStore.reset(),

    'tokens.list': () => ({ tokens: tokens.list() }),
    'tokens.issue' (p) {
      const { role = 'agent', ttlSec = 24 * 3600, label } = needObj(p)
      if (!TOKEN_ROLES.includes(role)) throw apiError('INVALID_REQUEST', 'role must be agent or operator')
      if (!Number.isInteger(ttlSec) || ttlSec < MIN_TTL_SEC || ttlSec > MAX_TTL_SEC) throw apiError('INVALID_REQUEST', 'ttlSec out of range')
      const before = new Set(tokens.list().map((t) => t.id))
      const token = tokens.issue(role, ttlSec * 1000, { label })
      const info = tokens.list().find((t) => !before.has(t.id))
      return { token, info }
    },
    'tokens.revoke' (p) {
      const { id } = needObj(p)
      if (typeof id !== 'string') throw apiError('INVALID_REQUEST', 'id is required')
      return { revoked: tokens.revoke(id) }
    },

    'confirmations.list': () => ({ items: api.confirmations.list() }),
    'confirmations.decide' (p) {
      const { confirmationId, approve } = needObj(p)
      if (typeof confirmationId !== 'string' || typeof approve !== 'boolean') throw apiError('INVALID_REQUEST', 'confirmationId and approve are required')
      return api.confirmations.decide(confirmationId, approve, api.confirmations.localToken())
    },
    // The UI registers while it can show confirmation prompts; without it, confirm-effects fail closed.
    'approver.register' () {
      if (!unregister) unregister = api.confirmations.registerApprover()
      startEvents()
      return { registered: true }
    },
    'approver.unregister' () {
      if (unregister) unregister()
      unregister = null
      return { registered: false }
    },

    'events.subscribe' () { startEvents(); return { subscribed: true, channel: EVENT_CHANNEL } },
    'events.unsubscribe' () { stopEvents(); return { subscribed: false } },
    'events.since' (p) {
      const { seq = 0 } = isObj(p) ? p : {}
      return { events: api.events.since(Number.isInteger(seq) && seq >= 0 ? seq : 0) }
    },

    'staging.import' (p) {
      const { path: src } = needObj(p)
      if (!api.staging) throw apiError('CAPABILITY_MISSING', 'Staging area is not configured')
      return api.staging.importPath(src)
    },

    async 'command.execute' (p) {
      const { command, params = {}, browserId, tabId, leaseId } = needObj(p)
      if (typeof command !== 'string' || UI_BLOCKED.has(command)) throw apiError('POLICY_DENIED', 'This command cannot be run from the UI')
      const res = await api.dispatcher.execute({
        v: 1,
        requestId: 'ui_' + crypto.randomBytes(6).toString('hex'),
        command,
        params,
        ...(browserId ? { browserId } : {}),
        ...(tabId ? { tabId } : {}),
        ...(leaseId ? { leaseId } : {})
      }, UI_ACTOR)
      return res
    }
  }

  return {
    actions: () => Object.keys(actions),
    async handle (action, payload) {
      const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null
      if (!fn) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unknown browserHub action' } }
      try {
        return { ok: true, result: await fn(payload) }
      } catch (e) {
        const known = e && typeof e.code === 'string'
        return { ok: false, error: { code: known ? e.code : 'INTERNAL', message: known ? String(e.message).slice(0, 300) : 'Internal error' } }
      }
    },
    dispose () {
      stopEvents()
      if (controlCenter) controlCenter.dispose()
      if (unregister) unregister()
      unregister = null
    },
    EVENT_CHANNEL
  }
}

module.exports = { createBrowserHubController, UI_ACTOR, UI_BLOCKED, EVENT_CHANNEL }
