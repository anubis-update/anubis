/**
 * Web storage access over CDP for http(s) origins only (storage.get/set/clear).
 * - get/set run in the page of the given tab; the tab's current origin must be
 *   http or https (never file:, chrome:, about:, data:, extension pages).
 * - clear uses Storage.clearDataForOrigin for an explicit http(s) origin.
 */

const { apiError } = require('./browser-api/errors')

const MAX_VALUE = 100000
const MAX_ENTRIES = 500
const MAX_TOTAL = 262144

const TYPE_MAP = {
  cookies: 'cookies',
  local_storage: 'local_storage',
  indexeddb: 'indexeddb',
  cache: 'cache_storage',
  service_workers: 'service_workers'
}

function httpOrigin (url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return u.origin
}

function createStorageDriver ({ tabs, send }) {
  const call = send || ((tabId, method, params) => tabs.send(tabId, method, params))

  function requireHttp (tabId) {
    const origin = httpOrigin(tabs.info(tabId).url)
    if (!origin) throw apiError('CAPABILITY_MISSING', 'Storage access is limited to http(s) pages')
    return origin
  }

  async function evalIn (tabId, expression) {
    const r = await call(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r && r.exceptionDetails) throw apiError('INVALID_REQUEST', 'Storage is not accessible on this page')
    return r && r.result ? r.result.value : undefined
  }

  async function get (tabId, { kind, keys }) {
    const origin = requireHttp(tabId)
    if (kind === 'indexedDB.names') {
      const names = await evalIn(tabId, '(async()=>{try{return (await indexedDB.databases()).map(d=>String(d.name)).slice(0,200)}catch(e){return []}})()')
      return { origin, entries: { names: JSON.stringify(Array.isArray(names) ? names : []) }, untrusted: true }
    }
    if (kind !== 'localStorage' && kind !== 'sessionStorage') throw apiError('INVALID_REQUEST', 'Unknown storage kind')
    const want = keys && keys.length ? JSON.stringify(keys.map(String)) : 'null'
    const raw = await evalIn(tabId, `(()=>{const s=window.${kind};const w=${want};const out={};let n=0;const ks=w||Object.keys(s);for(const k of ks){if(n++>=${MAX_ENTRIES})break;const v=s.getItem(k);if(v!==null)out[k]=String(v).slice(0,${MAX_VALUE})}return out})()`)
    const entries = {}
    let total = 0
    let truncated = false
    for (const [k, v] of Object.entries(raw || {})) {
      total += k.length + String(v).length
      if (total > MAX_TOTAL) { truncated = true; break }
      entries[k] = String(v)
    }
    return { origin, entries, ...(truncated ? { truncated } : {}), untrusted: true }
  }

  async function set (tabId, { kind, entries }) {
    const origin = requireHttp(tabId)
    if (kind !== 'localStorage' && kind !== 'sessionStorage') throw apiError('INVALID_REQUEST', 'Unknown storage kind')
    const keys = Object.keys(entries || {})
    if (keys.length > 100) throw apiError('LIMIT_EXCEEDED', 'Too many entries')
    const n = await evalIn(tabId, `(()=>{const s=window.${kind};const e=${JSON.stringify(entries || {})};let n=0;for(const k of Object.keys(e)){s.setItem(k,String(e[k]));n++}return n})()`)
    return { origin, set: typeof n === 'number' ? n : keys.length }
  }

  async function clear (tabId, { origin, types }) {
    const o = httpOrigin(origin)
    if (!o || o !== String(origin).replace(/\/$/, '')) throw apiError('INVALID_REQUEST', 'origin must be a plain http(s) origin')
    const list = (types && types.length ? types : Object.keys(TYPE_MAP)).map((t) => TYPE_MAP[t]).filter(Boolean)
    await call(tabId, 'Storage.clearDataForOrigin', { origin: o, storageTypes: [...new Set(list)].join(',') })
    return { origin: o, cleared: true }
  }

  return { get, set, clear }
}

module.exports = { createStorageDriver, httpOrigin }
