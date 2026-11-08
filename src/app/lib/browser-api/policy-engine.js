/**
 * Policy engine (policy.schema.json): first-match-wins per role, default deny.
 * Commands with risk sensitive/dangerous need an EXPLICIT non-"*" allow rule.
 * Domain/URL checks cover blocked schemes, private networks (incl. IPv6-mapped
 * IPv4) and allow/deny lists.
 */

const DEFAULT_AGENT_RULES = [
  { command: 'aegis.*', effect: 'deny' },
  { command: 'page.evaluate', effect: 'deny' },
  { command: 'passwords.*', effect: 'deny' },
  { command: 'extension.install', effect: 'deny' },
  { command: 'extension.remove', effect: 'deny' },
  { command: 'devMode.set', effect: 'deny' },
  { command: 'cookies.*', effect: 'deny' },
  { command: 'site.domains', effect: 'confirm' },
  { command: 'history.clear', effect: 'deny' },
  { command: 'storage.*', effect: 'deny' },
  { command: 'history.list', effect: 'confirm' },
  { command: 'history.search', effect: 'confirm' },
  { command: 'credential.fill', effect: 'confirm' },
  { command: 'page.upload', effect: 'confirm' },
  { command: 'browser.launch', effect: 'confirm' },
  { command: 'profile.select', effect: 'confirm' },
  { command: 'extension.enable', effect: 'confirm' },
  { command: '*', effect: 'allow' }
]

const DEFAULT_OPERATOR_RULES = [
  { command: 'passwords.*', effect: 'confirm' },
  { command: 'extension.install', effect: 'confirm' },
  { command: 'extension.remove', effect: 'confirm' },
  { command: 'devMode.set', effect: 'confirm' },
  { command: 'history.clear', effect: 'confirm' },
  { command: 'storage.clear', effect: 'confirm' },
  { command: '*', effect: 'allow' }
]

const DEFAULT_POLICY = {
  version: 1,
  defaultEffect: 'deny',
  roles: {
    admin: { rules: [{ command: '*', effect: 'allow' }], firstMatchWins: true },
    operator: { rules: DEFAULT_OPERATOR_RULES, firstMatchWins: true },
    agent: { rules: DEFAULT_AGENT_RULES, firstMatchWins: true }
  },
  domains: {
    mode: 'denylist',
    allow: [],
    deny: [],
    blockPrivateNetworks: true,
    blockSchemes: ['file', 'chrome', 'edge', 'devtools', 'chrome-extension', 'view-source', 'javascript', 'data']
  },
  limits: {
    maxBrowsers: 2,
    maxTabsPerBrowser: 20,
    maxCommandsPerMinute: 120,
    maxConcurrentCommands: 4,
    maxQueue: 64,
    defaultTimeoutMs: 15000,
    maxSnapshotBytes: 262144,
    maxScreenshotBytes: 2097152
  },
  confirmation: { timeoutSec: 120, channel: 'local-ui', rememberMinutes: 0 },
  redaction: { maskPasswordFields: true, maskPatterns: [], stripKnownSecrets: true },
  audit: { screenshots: 'on-sensitive', retainDays: 90 },
  extensions: { allowInstall: false }
}

const STRICTNESS = { allow: 0, confirm: 1, deny: 2 }

function globMatch (pattern, name) {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

function hostMatches (pattern, host) {
  const p = String(pattern).toLowerCase()
  if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1))
  return host === p
}

function isPrivateHost (hostname) {
  let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const mapped = h.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/)
  if (mapped) {
    const m = mapped[1]
    if (m.includes('.')) h = m
    else {
      const parts = m.split(':').map((x) => parseInt(x, 16))
      if (parts.length === 2 && parts.every(Number.isFinite)) h = `${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`
    }
  }
  if (/^\d+$/.test(h)) { // decimal IPv4 like 2130706433
    const n = Number(h)
    if (n <= 0xffffffff) h = `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224
  }
  if (h.includes(':')) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
  }
  return false
}

function mergeOverlay (base, overlay) {
  if (!overlay) return base
  const out = JSON.parse(JSON.stringify(base))
  for (const role of Object.keys(overlay.roles || {})) {
    const extra = (overlay.roles[role] && overlay.roles[role].rules) || []
    out.roles[role].rules = [...extra, ...out.roles[role].rules]
  }
  if (overlay.domains) {
    const d = out.domains
    const o = overlay.domains
    d.deny = [...new Set([...(d.deny || []), ...(o.deny || [])])]
    if (o.allow && o.allow.length) d.allow = d.allow && d.allow.length ? d.allow.filter((x) => o.allow.includes(x)) : o.allow
    if (o.mode === 'allowlist') d.mode = 'allowlist'
    if (o.blockPrivateNetworks === true) d.blockPrivateNetworks = true
    d.blockSchemes = [...new Set([...(d.blockSchemes || []), ...(o.blockSchemes || [])])]
  }
  for (const k of ['limits']) {
    for (const key of Object.keys((overlay[k]) || {})) {
      const v = overlay[k][key]
      if (typeof v === 'number' && typeof out[k][key] === 'number') out[k][key] = Math.min(out[k][key], v)
    }
  }
  if (overlay.redaction) {
    out.redaction.maskPatterns = [...(out.redaction.maskPatterns || []), ...(overlay.redaction.maskPatterns || [])]
  }
  if (overlay.extensions && overlay.extensions.allowInstall === false) out.extensions = { ...(out.extensions || {}), allowInstall: false }
  if (overlay.confirmation && overlay.confirmation.timeoutSec) out.confirmation.timeoutSec = Math.min(out.confirmation.timeoutSec, overlay.confirmation.timeoutSec)
  return out
}

function createPolicyEngine ({ policy = DEFAULT_POLICY, adminOverlay } = {}) {
  let current = mergeOverlay(policy, adminOverlay)
  const hourly = new Map() // role:cmd -> timestamps

  function evaluate ({ role = 'agent', command, risk = 'read', engine, domain, now = Date.now() }) {
    const rules = (current.roles[role] && current.roles[role].rules) || []
    for (const rule of rules) {
      if (!globMatch(rule.command, command)) continue
      if (rule.engines && rule.engines.length && engine && !rule.engines.includes(engine)) continue
      if (rule.domains && rule.domains.length && !(domain && rule.domains.some((p) => hostMatches(p, domain)))) continue
      const wildcard = rule.command === '*'
      if (wildcard && rule.effect === 'allow' && (risk === 'sensitive' || risk === 'dangerous') && role !== 'admin') {
        return { effect: 'deny', reason: 'sensitive/dangerous commands need an explicit allow rule', rule }
      }
      if (rule.maxPerHour && rule.effect === 'allow') {
        const k = role + ':' + rule.command
        const list = (hourly.get(k) || []).filter((t) => now - t < 3600000)
        if (list.length >= rule.maxPerHour) return { effect: 'deny', reason: 'hourly limit reached', rule }
        list.push(now)
        hourly.set(k, list)
      }
      return { effect: rule.effect, rule }
    }
    return { effect: 'deny', reason: 'no matching rule (default deny)' }
  }

  function checkUrl (url) {
    const d = current.domains || {}
    let u
    try { u = new URL(url) } catch { return { ok: false, reason: 'Invalid URL' } }
    const scheme = u.protocol.replace(/:$/, '').toLowerCase()
    if (scheme === 'about' && url === 'about:blank') return { ok: true }
    if ((d.blockSchemes || []).includes(scheme) || scheme === 'about') return { ok: false, reason: `Scheme ${scheme}: is blocked` }
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: `Scheme ${scheme}: is not allowed` }
    const host = u.hostname.toLowerCase()
    if (d.blockPrivateNetworks !== false && isPrivateHost(host)) return { ok: false, reason: 'Private network targets are blocked' }
    if ((d.deny || []).some((p) => hostMatches(p, host) || host.endsWith('.' + String(p).toLowerCase()))) return { ok: false, reason: 'Domain is denied by policy' }
    if (d.mode === 'allowlist' && !(d.allow || []).some((p) => hostMatches(p, host))) return { ok: false, reason: 'Domain is not in the allowlist' }
    return { ok: true, host }
  }

  return {
    evaluate,
    checkUrl,
    limits: () => current.limits,
    confirmation: () => current.confirmation,
    redaction: () => current.redaction,
    audit: () => current.audit,
    extensions: () => ({ allowInstall: false, ...(current.extensions || {}) }),
    snapshot: () => JSON.parse(JSON.stringify(current)),
    setPolicy: (p, overlay = adminOverlay) => { current = mergeOverlay(p, overlay) }
  }
}

module.exports = { createPolicyEngine, DEFAULT_POLICY, DEFAULT_AGENT_RULES, isPrivateHost, mergeOverlay, STRICTNESS }
