/**
 * Policy get/set for the LOCAL UI only (never reachable from /v1 or MCP).
 * Input is whitelisted and sanitised field by field: unknown keys are dropped,
 * values are range-checked, regexes must compile. The sanitised document is
 * applied to the live policy engine and persisted through `io`.
 */

const { apiError } = require('./errors')
const { DEFAULT_POLICY } = require('./policy-engine')

const EFFECTS = ['allow', 'confirm', 'deny']
const ROLES = ['admin', 'operator', 'agent']
const CMD_RE = /^(\*|[a-z][A-Za-z]*(\.(\*|[A-Za-z]+))?)$/
const HOST_RE = /^(\*\.)?[a-z0-9.-]{1,253}$/i
const LIMIT_BOUNDS = {
  maxBrowsers: [1, 10],
  maxTabsPerBrowser: [1, 100],
  maxCommandsPerMinute: [1, 6000],
  maxConcurrentCommands: [1, 32],
  maxQueue: [1, 1024],
  defaultTimeoutMs: [1000, 120000],
  maxSnapshotBytes: [1024, 4194304],
  maxScreenshotBytes: [1024, 16777216]
}

const bad = (m) => apiError('INVALID_REQUEST', 'Invalid policy: ' + m)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function strList (v, name, re, max = 200) {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > max) throw bad(name)
  for (const x of v) if (typeof x !== 'string' || !re.test(x)) throw bad(name)
  return [...v]
}

function sanitizeRule (r) {
  if (!isObj(r) || typeof r.command !== 'string' || !CMD_RE.test(r.command) || !EFFECTS.includes(r.effect)) throw bad('rule')
  const out = { command: r.command, effect: r.effect }
  if (r.engines !== undefined) out.engines = strList(r.engines, 'rule.engines', /^(chrome|edge)$/, 4)
  if (r.domains !== undefined) out.domains = strList(r.domains, 'rule.domains', HOST_RE)
  if (r.maxPerHour !== undefined) {
    if (!Number.isInteger(r.maxPerHour) || r.maxPerHour < 1 || r.maxPerHour > 100000) throw bad('rule.maxPerHour')
    out.maxPerHour = r.maxPerHour
  }
  return out
}

function sanitize (doc) {
  if (!isObj(doc) || doc.version !== 1) throw bad('version must be 1')
  const out = { version: 1 }
  if (!EFFECTS.includes(doc.defaultEffect)) throw bad('defaultEffect')
  out.defaultEffect = doc.defaultEffect
  if (!isObj(doc.roles)) throw bad('roles')
  out.roles = {}
  for (const role of ROLES) {
    const r = doc.roles[role]
    if (!isObj(r) || !Array.isArray(r.rules) || r.rules.length > 200) throw bad('roles.' + role)
    out.roles[role] = { rules: r.rules.map(sanitizeRule), firstMatchWins: true }
  }
  const d = isObj(doc.domains) ? doc.domains : {}
  out.domains = {
    mode: d.mode === 'allowlist' ? 'allowlist' : 'denylist',
    allow: strList(d.allow, 'domains.allow', HOST_RE),
    deny: strList(d.deny, 'domains.deny', HOST_RE),
    blockPrivateNetworks: d.blockPrivateNetworks !== false,
    blockSchemes: [...new Set([...DEFAULT_POLICY.domains.blockSchemes, ...strList(d.blockSchemes, 'domains.blockSchemes', /^[a-z][a-z0-9+.-]{0,30}$/, 50)])]
  }
  const l = isObj(doc.limits) ? doc.limits : {}
  out.limits = {}
  for (const [k, [lo, hi]] of Object.entries(LIMIT_BOUNDS)) {
    const v = l[k] === undefined ? DEFAULT_POLICY.limits[k] : l[k]
    if (!Number.isInteger(v) || v < lo || v > hi) throw bad('limits.' + k)
    out.limits[k] = v
  }
  const c = isObj(doc.confirmation) ? doc.confirmation : {}
  const timeout = c.timeoutSec === undefined ? DEFAULT_POLICY.confirmation.timeoutSec : c.timeoutSec
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 900) throw bad('confirmation.timeoutSec')
  out.confirmation = { timeoutSec: timeout, channel: 'local-ui', rememberMinutes: 0 }
  const rd = isObj(doc.redaction) ? doc.redaction : {}
  const patterns = strList(rd.maskPatterns, 'redaction.maskPatterns', /^[\s\S]{1,200}$/, 50)
  for (const p of patterns) { try { new RegExp(p) } catch { throw bad('redaction.maskPatterns') } }
  out.redaction = { maskPasswordFields: true, maskPatterns: patterns, stripKnownSecrets: true }
  const a = isObj(doc.audit) ? doc.audit : {}
  const retain = a.retainDays === undefined ? DEFAULT_POLICY.audit.retainDays : a.retainDays
  if (!Number.isInteger(retain) || retain < 1 || retain > 3650) throw bad('audit.retainDays')
  out.audit = { screenshots: ['never', 'on-sensitive', 'always'].includes(a.screenshots) ? a.screenshots : 'on-sensitive', retainDays: retain }
  const ext = isObj(doc.extensions) ? doc.extensions : {}
  out.extensions = { allowInstall: ext.allowInstall === true }
  return out
}

function createPolicyStore ({ engine, io = {}, adminOverlay } = {}) {
  if (!engine) throw new TypeError('policy store requires an engine')
  return {
    // Persisted document (sanitised) or null; used when assembling the engine.
    load () {
      try {
        const raw = io.read && io.read()
        return raw ? sanitize(raw) : null
      } catch { return null }
    },
    get: () => ({ policy: engine.snapshot(), defaults: JSON.parse(JSON.stringify(DEFAULT_POLICY)), adminLocked: !!adminOverlay }),
    set (doc) {
      const clean = sanitize(doc)
      if (io.write) io.write(clean)
      engine.setPolicy(clean)
      return { policy: engine.snapshot() }
    },
    reset () {
      if (io.write) io.write(null)
      engine.setPolicy(DEFAULT_POLICY)
      return { policy: engine.snapshot() }
    }
  }
}

module.exports = { createPolicyStore, sanitize }
