/**
 * Deep redaction of anything leaving the device (responses, events, audit).
 * Known secrets (values the device typed/filled, plus URL/base64 encodings)
 * and operator-supplied regexes are replaced with [REDACTED]. Secrets are only
 * held in memory, never logged.
 */

const REDACTED = '[REDACTED]'
const MIN_SECRET_LEN = 4

function createRedactor ({ maskPatterns = [], stripKnownSecrets = true } = {}) {
  const secrets = new Set()
  const regexes = []
  for (const p of maskPatterns) {
    try { regexes.push(new RegExp(p, 'g')) } catch {}
  }

  function addSecret (value) {
    if (!stripKnownSecrets || typeof value !== 'string' || value.length < MIN_SECRET_LEN) return
    secrets.add(value)
    secrets.add(encodeURIComponent(value))
    secrets.add(Buffer.from(value, 'utf8').toString('base64'))
    secrets.add(Buffer.from(value, 'utf8').toString('hex'))
    secrets.add(JSON.stringify(value).slice(1, -1))
  }

  function redactString (s, state) {
    let out = s
    for (const sec of secrets) {
      if (out.includes(sec)) {
        out = out.split(sec).join(REDACTED)
        state.count++
      }
    }
    for (const re of regexes) {
      re.lastIndex = 0
      if (re.test(out)) {
        re.lastIndex = 0
        out = out.replace(re, REDACTED)
        state.count++
      }
    }
    return out
  }

  function walk (v, state, depth) {
    if (depth > 20) return REDACTED
    if (typeof v === 'string') return redactString(v, state)
    if (Array.isArray(v)) return v.map((x) => walk(x, state, depth + 1))
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of Object.keys(v)) o[redactString(k, state)] = walk(v[k], state, depth + 1)
      return o
    }
    return v
  }

  function redact (value) {
    const state = { count: 0 }
    return { value: walk(value, state, 0), count: state.count }
  }

  return { addSecret, redact, secretCount: () => secrets.size }
}

module.exports = { createRedactor, REDACTED }
