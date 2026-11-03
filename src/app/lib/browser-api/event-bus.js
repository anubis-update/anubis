/**
 * Event bus (events.schema.json): monotonic seq, ring buffer (1000 / 10 min),
 * collapse of high-frequency tab.title / tab.loading, URLs cut to origin+path,
 * redaction before anything is stored or delivered, `events.dropped` on gaps.
 */

const { safeUrl } = require('./errors')

const COLLAPSE = new Set(['tab.title', 'tab.loading'])

function createEventBus ({ redact = (v) => v, now = () => Date.now(), maxEvents = 1000, maxAgeMs = 10 * 60 * 1000 } = {}) {
  let seq = 0
  let buf = []
  const subs = new Set()

  function cleanData (data) {
    const d = { ...(data || {}) }
    if (typeof d.url === 'string') d.url = safeUrl(d.url)
    return d
  }

  function emit (event, { browserId, tabId, data } = {}) {
    const t = now()
    const ev = {
      v: 1,
      seq: ++seq,
      ts: new Date(t).toISOString(),
      event,
      ...(browserId ? { browserId } : {}),
      ...(tabId ? { tabId } : {}),
      data: redact(cleanData(data))
    }
    if (COLLAPSE.has(event)) {
      const idx = buf.findIndex((e) => e.event === event && e.tabId === tabId && e.browserId === browserId)
      if (idx >= 0) buf.splice(idx, 1)
    }
    buf.push(ev)
    while (buf.length > maxEvents) buf.shift()
    buf = buf.filter((e) => t - Date.parse(e.ts) <= maxAgeMs)
    for (const s of [...subs]) { try { s(ev) } catch {} }
    return ev
  }

  // Returns buffered events with seq > since, plus events.dropped if the gap was trimmed.
  function since (sinceSeq = 0) {
    const out = buf.filter((e) => e.seq > sinceSeq)
    const first = out.length ? out[0].seq : seq + 1
    const expected = sinceSeq + 1
    if (first > expected && sinceSeq < seq) {
      const dropped = { v: 1, seq: first - 1, ts: new Date(now()).toISOString(), event: 'events.dropped', data: { count: first - expected, fromSeq: expected, toSeq: first - 1 } }
      return [dropped, ...out]
    }
    return out
  }

  function subscribe (fn) {
    subs.add(fn)
    return () => subs.delete(fn)
  }

  return { emit, since, subscribe, lastSeq: () => seq }
}

module.exports = { createEventBus }
