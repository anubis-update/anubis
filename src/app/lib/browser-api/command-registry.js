/**
 * Command Registry + dispatcher: the single entry point used by the /v1 REST/WS
 * adapter and the MCP adapter. Registry (registry.json) is the source of truth
 * for names, params, risk, scope, capabilities and MCP names.
 *
 * Pipeline: envelope -> params -> scope -> idempotency -> capability ->
 * limits -> policy -> confirmation -> lease -> URL policy -> execute
 * (timeout/cancel) -> redact -> audit.
 */

const { apiError, toWireError } = require('./errors')
const { createValidator } = require('./schema-validate')
const { hashRequest } = require('./idempotency-cache')

const ID_RE = {
  requestId: /^[A-Za-z0-9_-]{8,64}$/,
  browserId: /^b_[a-z0-9]{8,32}$/,
  tabId: /^t_[a-z0-9]{8,32}$/,
  leaseId: /^l_[a-z0-9]{8,32}$/,
  taskId: /^[A-Za-z0-9_.:-]{1,64}$/
}
const RISK_ORDER = { read: 0, write: 1, sensitive: 2, dangerous: 3 }

function createCommandRegistry ({ registry, documents = {} } = {}) {
  const validator = createValidator({ documents, root: registry })
  const byName = new Map(registry.commands.map((c) => [c.name, c]))
  const byMcp = new Map(registry.commands.filter((c) => c.mcp).map((c) => [c.mcp, c]))
  return {
    version: registry.version,
    get: (name) => byName.get(name),
    byMcp: (name) => byMcp.get(name),
    list: () => registry.commands,
    validator,
    validateParams (def, params) { return validator.validate(def.params || { type: 'object' }, params === undefined ? {} : params) }
  }
}

function validateEnvelope (req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return 'Request must be an object'
  const allowed = new Set(['v', 'requestId', 'command', 'browserId', 'tabId', 'leaseId', 'taskId', 'timeoutMs', 'params', 'dryRun'])
  for (const k of Object.keys(req)) if (!allowed.has(k)) return 'Unknown field: ' + k.slice(0, 40)
  if (typeof req.command !== 'string' || !req.command) return 'command is required'
  if (typeof req.requestId !== 'string' || !ID_RE.requestId.test(req.requestId)) return 'requestId is invalid'
  for (const k of ['browserId', 'tabId', 'leaseId', 'taskId']) {
    if (req[k] !== undefined && (typeof req[k] !== 'string' || !ID_RE[k].test(req[k]))) return k + ' is invalid'
  }
  if (req.timeoutMs !== undefined && (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 100 || req.timeoutMs > 120000)) return 'timeoutMs is invalid'
  if (req.params !== undefined && (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params))) return 'params must be an object'
  return null
}

function createDispatcher ({
  registry,
  hub,
  handlers,
  policy,
  audit,
  redactor,
  idempotency,
  leases,
  confirmations,
  deviceId = 'device',
  transport = 'local-rest',
  unattendedRemote = false,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const inflight = new Map() // actor\0requestId -> AbortController
  const recent = [] // timestamps for per-minute rate
  let running = 0
  const queue = []

  function pickEngine (def, params, browserId, tabId) {
    if (tabId && def.scope === 'tabId') return hub.forTab(tabId)
    if (browserId && (def.scope === 'browserId' || def.scope === 'tabId')) return hub.forBrowser(browserId)
    return hub.engine((params && params.engine) || hub.defaultEngine)
  }

  async function acquireSlot (limits) {
    const max = limits.maxConcurrentCommands || 4
    if (running < max) { running++; return }
    if (queue.length >= (limits.maxQueue || 64)) throw apiError('RATE_LIMITED', 'Too many queued commands', { retryAfterMs: 1000 })
    await new Promise((resolve) => queue.push(resolve))
  }
  function releaseSlot () {
    const next = queue.shift()
    if (next) next(); else running--
  }

  function originOf (url) {
    try { const u = new URL(url); return u.origin === 'null' ? undefined : u.origin } catch { return undefined }
  }

  async function checkNavigatedUrl (driver, tabId, signal) {
    const url = driver.tabInfo(tabId).url
    if (!url || url === 'about:blank') return
    const r = policy.checkUrl(url)
    if (!r.ok) {
      try { await driver.navigate(tabId, 'goto', { url: 'about:blank', waitUntil: 'none' }) } catch {}
      throw apiError('POLICY_DENIED', 'Navigation blocked by policy: ' + r.reason)
    }
    void signal
  }

  async function execute (req, actor = { id: 'anonymous', role: 'agent', kind: 'agent' }) {
    const started = now()
    const requestId = req && typeof req.requestId === 'string' ? req.requestId : 'invalid'
    const audit1 = { deviceId, actor: { kind: actor.kind || actor.role, id: actor.id }, transport: actor.transport || transport, requestId }
    let def
    let decision = { effect: 'deny', rule: 'n/a' }
    let origin
    let idemKey = null
    let confirmation

    const finish = (err, result, extra = {}) => {
      const durationMs = now() - started
      let response
      if (err) {
        const wire = toWireError(err)
        response = { v: 1, requestId, ok: false, error: wire, durationMs }
      } else {
        const red = redactor.redact(result)
        response = { v: 1, requestId, ok: true, result: red.value, durationMs, ...extra }
      }
      try {
        audit.record({
          ...audit1,
          ...(req && req.taskId ? { taskId: req.taskId } : {}),
          command: def ? def.name : String((req && req.command) || 'unknown').slice(0, 80),
          ...(req && req.browserId ? { browserId: req.browserId } : {}),
          ...(req && req.tabId ? { tabId: req.tabId } : {}),
          ...(origin ? { origin } : {}),
          paramsDigest: req && req.params,
          decision: { ...decision, policyVersion: policy.snapshot().version, ...(confirmation ? { confirmation } : {}) },
          outcome: { ok: !err, ...(err ? { errorCode: response.error.code } : {}), durationMs, ...(!err && def && def.risk !== 'read' ? {} : {}) }
        })
      } catch {}
      if (idemKey) {
        const transient = err && ['RATE_LIMITED', 'CONFIRMATION_REQUIRED', 'BUSY', 'LEASE_REQUIRED', 'LEASE_EXPIRED', 'CONFIRMATION_TIMEOUT'].includes(response.error.code)
        idempotency.finish(idemKey.actor, idemKey.requestId, response, { keep: !transient })
      }
      return response
    }

    try {
      const envErr = validateEnvelope(req)
      if (envErr) throw apiError('INVALID_REQUEST', envErr)
      if (req.v !== 1) throw apiError('UNSUPPORTED_VERSION', 'Only API version 1 is supported', { details: { supported: [1] } })
      def = registry.get(req.command)
      if (!def) throw apiError('UNKNOWN_COMMAND', 'Unknown command')

      const pv = registry.validateParams(def, req.params)
      if (!pv.ok) throw apiError('INVALID_REQUEST', 'Invalid params', { details: { errors: pv.errors.slice(0, 10) } })
      const params = pv.value

      if (def.scope === 'browserId' && !req.browserId) throw apiError('INVALID_REQUEST', 'browserId is required')
      if (def.scope === 'tabId' && !req.tabId) throw apiError('INVALID_REQUEST', 'tabId is required')

      const risk = def.risk
      if (RISK_ORDER[risk] >= RISK_ORDER.write && !req.dryRun) {
        const hash = hashRequest(def.name, params, { b: req.browserId, t: req.tabId })
        const idem = idempotency.begin(actor.id, req.requestId, hash)
        if (idem.state === 'conflict') throw apiError('IDEMPOTENCY_CONFLICT', 'requestId was already used with different params')
        if (idem.state === 'replay') return { ...idem.response, replayed: true }
        if (idem.state === 'pending') return { ...(await idem.promise), replayed: true }
        idemKey = { actor: actor.id, requestId: req.requestId }
      }

      const driver = pickEngine(def, params, req.browserId, req.tabId)
      const caps = driver.capabilities()
      const missing = (def.requires || []).find((r) => !caps.has(r))
      if (missing) {
        if (driver.engine === 'rbi') throw apiError('NOT_SUPPORTED_BY_ENGINE', 'Not supported by this engine')
        throw apiError('CAPABILITY_MISSING', 'Capability not available: ' + missing, { details: { capability: missing } })
      }
      if (req.tabId && def.scope === 'tabId') {
        try { origin = originOf(driver.tabInfo(req.tabId).url) } catch {}
      }

      const limits = policy.limits()
      const t = now()
      while (recent.length && t - recent[0] > 60000) recent.shift()
      if (recent.length >= (limits.maxCommandsPerMinute || 120)) throw apiError('RATE_LIMITED', 'Command rate limit exceeded', { retryAfterMs: 5000 })
      recent.push(t)

      const verdict = policy.evaluate({ role: actor.role, command: def.name, risk, engine: driver.engine, domain: origin && new URL(origin).hostname })
      decision = { effect: verdict.effect, rule: verdict.rule ? verdict.rule.command : (verdict.reason || 'default-deny') }
      if (verdict.effect === 'deny') throw apiError('POLICY_DENIED', 'Denied by policy', { details: { command: def.name } })

      const urlParam = params && (params.url || (def.name === 'browser.launch' && params.url))
      if (urlParam) {
        const u = policy.checkUrl(urlParam)
        if (!u.ok) {
          decision = { effect: 'deny', rule: 'domains' }
          throw apiError('POLICY_DENIED', 'URL blocked by policy: ' + u.reason)
        }
      }

      if (req.dryRun) {
        return finish(null, { dryRun: true, allowed: verdict.effect === 'allow', requiresConfirmation: verdict.effect === 'confirm', risk })
      }

      if (verdict.effect === 'confirm') {
        if (unattendedRemote && actor.transport === 'control-center' && actor.kind === 'remote') {
          confirmation = { result: 'approved', channel: 'control-center' }
        } else {
          try {
            await confirmations.request({ command: def.name, summary: `${def.name}${origin ? ' on ' + origin : ''}`, actor: actor.id })
            confirmation = { result: 'approved', channel: 'local-ui' }
          } catch (e) {
            confirmation = { result: e && e.code === 'CONFIRMATION_TIMEOUT' ? 'timeout' : 'rejected', channel: 'local-ui' }
            throw e
          }
        }
      }

      if (RISK_ORDER[risk] >= RISK_ORDER.write) {
        const bid = req.browserId || (req.tabId && (() => { try { return driver.browserOf(req.tabId) } catch { return undefined } })())
        if (bid && !def.name.startsWith('lease.')) leases.check({ browserId: bid, actor: actor.id, role: actor.role, leaseId: req.leaseId })
      }

      const ctrl = new AbortController()
      const ikey = actor.id + '\0' + req.requestId
      inflight.set(ikey, ctrl)
      const timeoutMs = req.timeoutMs || limits.defaultTimeoutMs || 15000
      await acquireSlot(limits)
      let timer
      try {
        const handler = handlers[def.name]
        if (!handler) throw apiError('UNKNOWN_COMMAND', 'Command is not implemented')
        const result = await Promise.race([
          handler({ params, browserId: req.browserId, tabId: req.tabId, leaseId: req.leaseId, actor, driver, signal: ctrl.signal, def }),
          new Promise((resolve, reject) => {
            timer = setTimer(() => { ctrl.abort(); reject(apiError('TIMEOUT', 'Command timed out')) }, timeoutMs)
          }),
          new Promise((resolve, reject) => ctrl.signal.addEventListener('abort', () => reject(apiError('CANCELLED', 'Command was cancelled')), { once: true }))
        ])
        if (req.tabId && ['tab.goto', 'tab.reload', 'tab.back', 'tab.forward', 'page.click', 'page.press', 'page.type'].includes(def.name)) {
          await checkNavigatedUrl(driver, req.tabId)
        }
        const bid = req.browserId || (req.tabId && driver.browserOf && driver.browserOf(req.tabId))
        if (bid) leases.touch(bid, actor.id)
        return finish(null, result)
      } finally {
        clearTimer(timer)
        inflight.delete(ikey)
        releaseSlot()
      }
    } catch (e) {
      return finish(e)
    }
  }

  function cancel (requestId, actor) {
    const c = inflight.get(actor.id + '\0' + requestId)
    if (!c) return false
    c.abort()
    return true
  }

  return { execute, cancel }
}

module.exports = { createCommandRegistry, createDispatcher, validateEnvelope }
