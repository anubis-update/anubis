/** Idempotency cache: (actor, requestId) -> {hash, response}; 15 min TTL, LRU 4096. */

const crypto = require('node:crypto')

function canonical (v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function hashRequest (command, params, scope = {}) {
  return crypto.createHash('sha256').update(canonical({ command, params, scope })).digest('hex')
}

function createIdempotencyCache ({ ttlMs = 15 * 60 * 1000, max = 4096, now = () => Date.now() } = {}) {
  const map = new Map() // key -> { hash, response, at, pending }

  const keyOf = (actor, requestId) => actor + '\0' + requestId

  function prune () {
    const t = now()
    for (const [k, v] of map) {
      if (!v.pending && t - v.at > ttlMs) map.delete(k)
      else break
    }
    while (map.size > max) map.delete(map.keys().next().value)
  }

  // Returns { state: 'new' } | { state: 'replay', response } | { state: 'pending', promise } | { state: 'conflict' }
  function begin (actor, requestId, hash) {
    prune()
    const k = keyOf(actor, requestId)
    const e = map.get(k)
    if (!e) {
      let settle
      const promise = new Promise((resolve) => { settle = resolve })
      map.set(k, { hash, at: now(), pending: true, promise, resolve: settle })
      return { state: 'new' }
    }
    if (e.hash !== hash) return { state: 'conflict' }
    map.delete(k)
    map.set(k, e) // LRU touch
    if (e.pending) return { state: 'pending', promise: e.promise }
    return { state: 'replay', response: e.response }
  }

  function finish (actor, requestId, response, { keep = true } = {}) {
    const k = keyOf(actor, requestId)
    const e = map.get(k)
    if (!e) return
    e.pending = false
    e.response = response
    e.at = now()
    if (e.resolve) e.resolve(response)
    if (!keep) map.delete(k)
  }

  return { begin, finish, size: () => map.size }
}

module.exports = { createIdempotencyCache, hashRequest, canonical }
