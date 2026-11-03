const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPageDriver, parseKey } = require('../../app/lib/cdp-ax')

function fakeTabs (handlers) {
  const calls = []
  return {
    calls,
    get: () => ({ url: 'https://a.test/', title: 'T' }),
    send: async (tabId, method, params) => {
      calls.push({ method, params })
      const h = handlers[method]
      return typeof h === 'function' ? h(params) : (h || {})
    }
  }
}

const AX = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' } },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 11 },
    { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: 'Pass' }, value: { value: 'hunter2' }, backendDOMNodeId: 12 },
    { nodeId: '4', parentId: '1', role: { value: 'textbox' }, name: { value: 'User' }, backendDOMNodeId: 13 },
    { nodeId: '5', ignored: true, role: { value: 'button' } }
  ]
}
const handlers = {
  'Accessibility.getFullAXTree': AX,
  'DOM.describeNode': (p) => ({ node: { attributes: p.backendNodeId === 12 ? ['type', 'password'] : ['type', 'text'] } }),
  'DOM.getBoxModel': { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], width: 10, height: 10 } }
}

test('snapshot builds refs, skips ignored, masks passwords', async () => {
  const d = createPageDriver({ tabs: fakeTabs(handlers) })
  const s = await d.snapshot('t_1')
  assert.equal(s.untrusted, true)
  assert.equal(s.nodes.length, 3)
  const pw = s.nodes.find((n) => n.name === 'Pass')
  assert.equal(pw.value, '•••')
  assert.ok(pw.states.includes('password'))
  assert.ok(!JSON.stringify(s).includes('hunter2'))
})

test('stale snapshot id and unknown ref give STALE_REF', async () => {
  const d = createPageDriver({ tabs: fakeTabs(handlers) })
  const s1 = await d.snapshot('t_1')
  await d.snapshot('t_1')
  await assert.rejects(d.click('t_1', { ref: 'e1', snapshotId: s1.snapshotId }), (e) => e.code === 'STALE_REF')
  await assert.rejects(d.click('t_1', { ref: 'e99' }), (e) => e.code === 'STALE_REF')
})

test('click dispatches mouse events at box center', async () => {
  const tabs = fakeTabs(handlers)
  const d = createPageDriver({ tabs })
  await d.snapshot('t_1')
  await d.click('t_1', { ref: 'e1' })
  const pressed = tabs.calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')
  assert.equal(pressed.params.x, 5)
})

test('type into password field is POLICY_DENIED; normal field inserts text', async () => {
  const tabs = fakeTabs(handlers)
  const d = createPageDriver({ tabs })
  await d.snapshot('t_1')
  await assert.rejects(d.type('t_1', { ref: 'e2', text: 'x' }), (e) => e.code === 'POLICY_DENIED')
  await d.type('t_1', { ref: 'e3', text: 'bob' })
  assert.ok(tabs.calls.some((c) => c.method === 'Input.insertText' && c.params.text === 'bob'))
})

test('press printable in focused password field is denied; Enter allowed', async () => {
  const tabs = fakeTabs({ ...handlers, 'Runtime.evaluate': { result: { value: true } } })
  const d = createPageDriver({ tabs })
  await assert.rejects(d.press('t_1', { key: 'a' }), (e) => e.code === 'POLICY_DENIED')
  await d.press('t_1', { key: 'Enter' })
})

test('box failure maps to STALE_REF; parseKey handles modifiers', async () => {
  const d = createPageDriver({ tabs: fakeTabs({ ...handlers, 'DOM.getBoxModel': () => { throw new Error('gone') } }) })
  await d.snapshot('t_1')
  await assert.rejects(d.click('t_1', { ref: 'e1' }), (e) => e.code === 'STALE_REF')
  assert.equal(parseKey('Control+a').modifiers, 2)
  assert.throws(() => parseKey('Foo+a'))
})
