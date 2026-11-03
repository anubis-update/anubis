/**
 * Per-redirect navigation guard. Document requests (top-level and frames) are
 * paused through `Fetch` in each tab session; every http(s) hop, including each
 * redirect target, is checked against the policy before it is allowed to go on.
 * Only http(s) is intercepted: `data:` documents never reach Fetch.requestPaused
 * (verified empirically) and non-http schemes are handled by the dispatcher.
 * Fails closed: if the check itself throws, the request is failed.
 */

function createNavGuard ({ client, checkUrl, emit = () => {} } = {}) {
  if (!client || typeof checkUrl !== 'function') throw new TypeError('nav guard requires client and checkUrl')
  const bound = new Set()

  async function attach (sessionId, tabId) {
    if (!bound.has(sessionId)) {
      bound.add(sessionId)
      client.on('Fetch.requestPaused', (p) => { handle(p, sessionId, tabId) }, sessionId)
    }
    await client.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: 'https://*', resourceType: 'Document', requestStage: 'Request' }
      ]
    }, sessionId)
  }

  async function handle (p, sessionId, tabId) {
    const url = String((p.request && p.request.url) || '')
    let verdict
    try {
      verdict = /^https?:/i.test(url) ? checkUrl(url) : { ok: true }
    } catch {
      verdict = { ok: false, reason: 'Policy check failed' }
    }
    try {
      if (verdict.ok) {
        await client.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId)
      } else {
        await client.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId)
        let origin = ''
        try { origin = new URL(url).origin } catch {}
        emit('navigation.blocked', { tabId, data: { origin, reason: verdict.reason, redirect: !!p.redirectedRequestId } })
      }
    } catch {}
  }

  return { attach, forget: (sessionId) => bound.delete(sessionId) }
}

module.exports = { createNavGuard }
