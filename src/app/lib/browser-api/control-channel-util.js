/**
 * Helpers for the Control Center channel (SPEC-v1 §11): URL policy, canonical
 * JSON, Ed25519 signing, secret scrubbing. No I/O, no Electron.
 */

const crypto = require('node:crypto')

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const SECRET_KEYS = /^(cookies?|set-cookie|password|passwd|secret|authorization|access_?token|refresh_?token|private_?key|enrollment_?token)$/i

function parseCcUrl (raw, { allowInsecureLocal = false } = {}) {
  let u
  try { u = new URL(String(raw)) } catch { throw ccError('INVALID_URL', 'Control Center URL is invalid') }
  if (u.username || u.password) throw ccError('INVALID_URL', 'Credentials in the URL are not allowed')
  if (u.protocol === 'wss:') return u
  if (u.protocol === 'ws:' && allowInsecureLocal && LOCAL_HOSTS.has(u.hostname)) return u
  throw ccError('INSECURE_TRANSPORT', 'Control Center URL must use wss://')
}

function enrollUrl (wsUrl) {
  const u = new URL(wsUrl.href)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = '/enroll'
  u.search = ''
  u.hash = ''
  return u
}

function ccError (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function canonical (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

function generateKeyPair () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

function sign (privateKeyB64, data) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' })
  return crypto.sign(null, Buffer.from(data), key).toString('base64')
}

function verify (publicKeyB64, data, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(sigB64), 'base64'))
  } catch { return false }
}

function fingerprint (publicKeyB64) {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32)
}

const helloMessage = (deviceId, nonce, challenge) => `anubis-hello-v1\n${deviceId}\n${nonce}\n${challenge}`
const welcomeMessage = (sessionId, nonce, challenge) => `anubis-welcome-v1\n${sessionId}\n${nonce}\n${challenge}`

function frameForSig (frame) {
  const rest = { ...frame }
  delete rest.sig
  return canonical(rest)
}

// Defence in depth on top of the dispatcher redactor: secret-looking keys never leave.
function scrub (value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((x) => scrub(x, depth + 1))
  const out = {}
  for (const k of Object.keys(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(value[k], depth + 1)
  return out
}

module.exports = { parseCcUrl, enrollUrl, ccError, canonical, generateKeyPair, sign, verify, fingerprint, helloMessage, welcomeMessage, frameForSig, scrub, SECRET_KEYS }
