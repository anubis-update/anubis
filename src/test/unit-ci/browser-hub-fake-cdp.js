// Shared fake CDP client for Browser Hub specs (not a spec itself).
function createFakeCdp (handlers = {}) {
  const listeners = []
  const calls = []
  const client = {
    calls,
    async send (method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      const h = handlers[method]
      if (typeof h === 'function') return h(params, sessionId)
      if (h !== undefined) return h
      return {}
    },
    on (method, cb, sessionId) {
      const listener = { method, cb, sessionId }
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit (method, params, sessionId) {
      for (const l of listeners) {
        if (l.method !== method) continue
        if (l.sessionId && sessionId && l.sessionId !== sessionId) continue
        l.cb(params, sessionId)
      }
    },
    close () {}
  }
  return client
}

module.exports = { createFakeCdp }
