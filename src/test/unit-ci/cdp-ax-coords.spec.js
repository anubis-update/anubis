const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPageDriver } = require('../../app/lib/cdp-ax')

function mk (extra = {}) {
  const calls = []
  const tabs = {
    get: () => ({ url: 'https://a.test/', title: 'T' }),
    send: async (id, method, params) => {
      calls.push({ method, params })
      const h = { 'DOM.getNodeForLocation': { backendNodeId: 77 }, 'DOM.resolveNode': { object: { objectId: 'obj1' } }, ...extra }[method]
      return typeof h === 'function' ? h(params) : (h || {})
    }
  }
  return { page: createPageDriver({ tabs }), calls }
}

test('upload by coordinates resolves the node at the point and sets files', async () => {
  const { page, calls } = mk({ 'Runtime.callFunctionOn': { result: { value: true } } })
  const r = await page.upload('t', { x: 10.4, y: 20.6, files: ['C:\\stage\\a.txt'] })
  assert.deepEqual(r, { uploaded: 1 })
  assert.deepEqual(calls[0].params, { x: 10, y: 21, includeUserAgentShadowDOM: false })
  assert.deepEqual(calls.find((c) => c.method === 'DOM.setFileInputFiles').params, { files: ['C:\\stage\\a.txt'], objectId: 'obj1' })
})

test('select by coordinates; no element at point -> ELEMENT_NOT_FOUND', async () => {
  const a = mk({ 'Runtime.callFunctionOn': { result: { value: 1 } } })
  assert.deepEqual(await a.page.select('t', { x: 1, y: 2, values: ['v'] }), { selected: 1 })
  const b = mk({ 'DOM.getNodeForLocation': {} })
  await assert.rejects(b.page.select('t', { x: 1, y: 2, values: ['v'] }), (e) => e.code === 'ELEMENT_NOT_FOUND')
})

test('upload to a non-file input is refused and sets nothing', async () => {
  const { page, calls } = mk({ 'Runtime.callFunctionOn': { result: { value: false } } })
  await assert.rejects(page.upload('t', { x: 1, y: 1, files: ['f'] }), (e) => e.code === 'ELEMENT_NOT_ACTIONABLE')
  assert.ok(!calls.some((c) => c.method === 'DOM.setFileInputFiles'))
})
