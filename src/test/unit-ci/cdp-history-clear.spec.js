const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHistoryClearer } = require('../../app/lib/cdp-history-clear')

function mk (script) {
  const calls = []
  const tabs = {
    newTab: async (o) => { calls.push(['new', o.url]); return { tab: { tabId: 't1' } } },
    close: async (id) => { calls.push(['close', id]) },
    send: async (id, m, p) => { calls.push(['send', p.expression.includes('#clearButton') ? 'clear' : 'done']); return { result: { value: script(p.expression) } } }
  }
  return { calls, clear: createHistoryClearer({ tabs, engine: 'edge', sleep: () => Promise.resolve() }) }
}

test('rejects partial ranges without opening anything', async () => {
  const { clear, calls } = mk(() => null)
  await assert.rejects(clear({ since: '2026-01-01T00:00:00Z' }), (e) => e.code === 'CAPABILITY_MISSING')
  assert.equal(calls.length, 0)
})

test('opens the edge settings page, clicks, waits for the dialog to close, closes the tab', async () => {
  const { clear, calls } = mk((x) => x.includes('#clearButton') ? 'clicked' : true)
  assert.deepEqual(await clear({}), { cleared: true })
  assert.deepEqual(calls[0], ['new', 'edge://settings/clearBrowserData'])
  assert.deepEqual(calls[calls.length - 1], ['close', 't1'])
})

test('missing UI -> CAPABILITY_MISSING and tab is still closed', async () => {
  const { clear, calls } = mk(() => 'no-ui')
  await assert.rejects(clear({}), (e) => e.code === 'CAPABILITY_MISSING')
  assert.deepEqual(calls[calls.length - 1], ['close', 't1'])
})

test('dialog never closing times out', async () => {
  const { clear } = mk((x) => x.includes('#clearButton') ? 'clicked' : false)
  await assert.rejects(clear({}), (e) => e.code === 'TIMEOUT')
})
