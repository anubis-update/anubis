const crypto = require('node:crypto')
const { promisify } = require('node:util')
const { apiError } = require('./errors')

const derive = promisify(crypto.scrypt)
const FORMAT = 'anubis-cookies-v1'
const MAX_BYTES = 2 * 1024 * 1024
const keys = new Set(['name', 'value', 'domain', 'path', 'expires', 'secure', 'httpOnly', 'sameSite', 'partitionKey'])

function normalizeCookies (cookies) {
  if (!Array.isArray(cookies) || cookies.length > 10000) throw apiError('INVALID_REQUEST', 'Invalid cookie file')
  const result = cookies.map(cookie => {
    if (!cookie || typeof cookie !== 'object' ||
        typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
        typeof cookie.domain !== 'string' || !/^\.?[a-z0-9.-]+$/i.test(cookie.domain) ||
        cookie.name.length > 1024 || cookie.value.length > 32768 ||
        (cookie.path !== undefined && (typeof cookie.path !== 'string' || !cookie.path.startsWith('/'))) ||
        (cookie.expires !== undefined && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) ||
        ['secure', 'httpOnly'].some(key => cookie[key] !== undefined && typeof cookie[key] !== 'boolean') ||
        (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite))) {
      throw apiError('INVALID_REQUEST', 'Invalid cookie record')
    }
    if (cookie.partitionKey !== undefined) {
      const p = cookie.partitionKey
      if (!p || typeof p !== 'object' || Object.keys(p).some(key => !['topLevelSite', 'hasCrossSiteAncestor'].includes(key)) ||
          typeof p.topLevelSite !== 'string' || typeof p.hasCrossSiteAncestor !== 'boolean') throw apiError('INVALID_REQUEST', 'Unsupported partitioned cookie')
      let site
      try { site = new URL(p.topLevelSite) } catch { throw apiError('INVALID_REQUEST', 'Invalid partitioned cookie site') }
      if (!['http:', 'https:'].includes(site.protocol) || site.origin !== p.topLevelSite) throw apiError('INVALID_REQUEST', 'Invalid partitioned cookie site')
    }
    return Object.fromEntries(Object.entries(cookie).filter(([key]) => keys.has(key)))
  })
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw apiError('LIMIT_EXCEEDED', 'Cookie file exceeds 2 MiB')
  return result
}

function passphrase (value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw apiError('INVALID_REQUEST', 'Use a file passphrase of 12 to 256 characters')
}

async function encryptCookies (cookies, password) {
  passphrase(password)
  const data = normalizeCookies(cookies)
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = await derive(password, salt, 32)
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(FORMAT))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    return {
      format: FORMAT,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    }
  } finally { key.fill(0) }
}

async function decryptCookies (artifact, password) {
  passphrase(password)
  if (!artifact || artifact.format !== FORMAT ||
      Object.keys(artifact).some(key => !['format', 'salt', 'iv', 'tag', 'data'].includes(key))) throw apiError('INVALID_REQUEST', 'Unsupported encrypted cookie file')
  const decode = (name, length) => {
    const text = artifact[name]
    if (typeof text !== 'string' || text.length > 3 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw apiError('INVALID_REQUEST', 'Invalid encrypted cookie file')
    const buffer = Buffer.from(text, 'base64')
    if ((length && buffer.length !== length) || buffer.length > MAX_BYTES) throw apiError('INVALID_REQUEST', 'Invalid encrypted cookie file')
    return buffer
  }
  const salt = decode('salt', 16)
  const iv = decode('iv', 12)
  const tag = decode('tag', 16)
  const data = decode('data')
  const key = await derive(password, salt, 32)
  let plain
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(FORMAT))
    cipher.setAuthTag(tag)
    plain = Buffer.concat([cipher.update(data), cipher.final()])
    return normalizeCookies(JSON.parse(plain.toString('utf8')))
  } catch {
    throw apiError('INVALID_REQUEST', 'Cookie file could not be decrypted or validated; check the passphrase and file')
  } finally { key.fill(0); if (plain) plain.fill(0) }
}

function createCookieTransfer ({ api, actor }) {
  let busy = false
  return async (kind, payload) => {
    if (!payload || payload.confirmed !== true || typeof payload.browserId !== 'string') throw apiError('INVALID_REQUEST', 'Explicit administrator confirmation and a running browser are required')
    if (busy) throw apiError('BUSY', 'Another cookie transfer is in progress')
    passphrase(payload.passphrase)
    const command = 'cookies.' + kind
    const driver = api.hub.forBrowser(payload.browserId)
    const verdict = api.policy.evaluate({ role: actor.role, command, risk: 'sensitive', engine: driver.engine })
    if (verdict.effect !== 'allow') throw apiError('POLICY_DENIED', 'Cookie transfer is disabled by device policy')
    api.leases.check({ browserId: payload.browserId, actor: actor.id, role: actor.role })
    const domains = payload.domains
    if (kind === 'export' && (!Array.isArray(domains) || !domains.length || domains.length > 100 ||
        domains.some(domain => typeof domain !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain)))) throw apiError('INVALID_REQUEST', 'Specify the domains to export, without a scheme, port or path')
    busy = true
    try {
      // Record consent before touching browser secrets; never include the payload.
      api.audit.record({ actor, transport: 'admin-ui', command, browserId: payload.browserId, decision: { effect: 'allow', rule: 'explicit-admin-file-transfer' }, outcome: { stage: 'confirmed' } })
      if (kind === 'export') {
        const cookies = await driver.cookies(payload.browserId, { domains })
        return { artifact: await encryptCookies(cookies, payload.passphrase), count: cookies.length }
      }
      const cookies = await decryptCookies(payload.artifact, payload.passphrase)
      const current = api.policy.evaluate({ role: actor.role, command, risk: 'sensitive', engine: driver.engine })
      if (current.effect !== 'allow') throw apiError('POLICY_DENIED', 'Cookie transfer was disabled by device policy')
      api.leases.check({ browserId: payload.browserId, actor: actor.id, role: actor.role })
      return driver.setCookies(payload.browserId, cookies)
    } finally { busy = false }
  }
}

module.exports = { createCookieTransfer, encryptCookies, decryptCookies, normalizeCookies }
