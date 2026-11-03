/**
 * history.clear through the browser's OWN "Clear browsing data" page
 * (chrome://settings/clearBrowserData / edge://settings/clearBrowserData),
 * driven the same way as the developer-mode toggle. Only browsing history is
 * selected (cookies and cache are explicitly unchecked) and the time range is
 * "all time"; partial ranges cannot be expressed through that UI faithfully, so
 * `since`/`until` are refused with CAPABILITY_MISSING instead of over-deleting.
 * Not verified live (internal pages are out of scope for automated tests).
 */

const { apiError } = require('./browser-api/errors')

const CLEAR_SCRIPT = `(() => {
  const find = (root, sel) => {
    const hit = root.querySelector(sel)
    if (hit) return hit
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = find(el.shadowRoot, sel); if (r) return r }
    }
    return null
  }
  const box = (id, want) => {
    const c = find(document, id)
    if (!c) return false
    if (!!c.checked !== want) c.click()
    return true
  }
  if (!box('#browsingCheckboxBasic', true)) return 'no-ui'
  box('#cookiesCheckboxBasic', false)
  box('#cacheCheckboxBasic', false)
  const range = find(document, '#clearFromBasic')
  const sel = range && (range.shadowRoot ? range.shadowRoot.querySelector('select') : range)
  if (sel) { sel.value = '4'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
  const btn = find(document, '#clearButton')
  if (!btn || btn.disabled) return 'no-button'
  btn.click()
  return 'clicked'
})()`

const DONE_SCRIPT = `(() => {
  const find = (root, sel) => {
    const hit = root.querySelector(sel)
    if (hit) return hit
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = find(el.shadowRoot, sel); if (r) return r }
    }
    return null
  }
  const d = find(document, 'settings-clear-browsing-data-dialog')
  const dlg = d && d.shadowRoot && d.shadowRoot.querySelector('#clearBrowsingDataDialog')
  return !dlg || !dlg.open
})()`

function createHistoryClearer ({ tabs, engine = 'chrome', sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return async function clear ({ since, until } = {}) {
    if (since || until) throw apiError('CAPABILITY_MISSING', 'Partial history ranges are not supported; omit since/until to clear all history')
    const scheme = engine === 'edge' ? 'edge' : 'chrome'
    const created = await tabs.newTab({ url: `${scheme}://settings/clearBrowserData`, activate: false })
    const tabId = created.tab.tabId
    try {
      let state = 'no-ui'
      for (let i = 0; i < 30 && state === 'no-ui'; i++) {
        await sleep(150)
        const r = await tabs.send(tabId, 'Runtime.evaluate', { expression: CLEAR_SCRIPT, returnByValue: true })
        state = (r && r.result && r.result.value) || 'no-ui'
      }
      if (state !== 'clicked') throw apiError('CAPABILITY_MISSING', 'The clear browsing data dialog was not found in this browser')
      for (let i = 0; i < 40; i++) {
        await sleep(150)
        const r = await tabs.send(tabId, 'Runtime.evaluate', { expression: DONE_SCRIPT, returnByValue: true })
        if (r && r.result && r.result.value === true) return { cleared: true }
      }
      throw apiError('TIMEOUT', 'History clearing did not finish in time')
    } finally {
      try { await tabs.close(tabId) } catch {}
    }
  }
}

module.exports = { createHistoryClearer }
