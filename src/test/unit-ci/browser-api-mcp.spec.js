const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBrowserApi } = require('../../app/lib/browser-api')
const registryJson = require('../../app/lib/browser-api/registry.json')
const commonSchema = require('../../app/lib/browser-api/common.schema.json')
const { createBrowserMcp, UNTRUSTED_PREFIX } = require('../../app/lib/browser-api/browser-mcp')
const { McpServer } = require('../../app/mcp/server/mcp.js')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function setup () {
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId }),
    'Accessibility.getFullAXTree': { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }] }
  })
  const files = new Map()
  const api = createBrowserApi({
    launchBrowser: async () => ({ client, userDataDir: 'u', close () {} }),
    resolveSourceDir: () => null,
    auditFs: { append: (n, l) => files.set(n, (files.get(n) || '') + l), read: (n) => files.get(n) || '', list: () => [...files.keys()] },
    historyReader: { available: false }
  })
  const mcp = createBrowserMcp({ api, commonSchema, registryDefs: registryJson.$defs })
  const server = new McpServer({ name: 't', version: '1' })
  const names = mcp.register(server)
  return { api, mcp, server, names }
}

test('mcp: tools generated from registry; denied commands absent; annotations + raw schema', () => {
  const { server, names } = setup()
  assert.ok(names.includes('tab_list') || names.length > 5, names.join())
  assert.equal(names.includes('page_evaluate'), false)
  assert.equal(names.includes('cookies_export'), false)
  const t = server.tools.get(names[0])
  assert.ok(t.inputSchema.__rawJsonSchema.type === 'object')
  assert.equal(typeof t.annotations.readOnlyHint, 'boolean')
  const json = JSON.stringify(names.map((n) => server.tools.get(n).inputSchema.__rawJsonSchema))
  assert.equal(json.includes('common.schema.json#'), false)
})

test('mcp: call routes through dispatcher; errors map to isError; untrusted prefix', async () => {
  const { server, api } = setup()
  const err = await server.tools.get('tab_list').handler({ browserId: 'b_abcd1234' })
  assert.equal(err.isError, true)
  assert.match(err.content[0].text, /^BROWSER_NOT_FOUND:/)
  const adminLaunch = await api.dispatcher.execute({ v: 1, requestId: 'req_adm00001', command: 'browser.launch', params: { engine: 'chrome' } }, { id: 'a', role: 'admin', kind: 'admin' })
  const b = adminLaunch.result.browserId
  const ok = await server.tools.get('tab_list').handler({ browserId: b })
  assert.equal(ok.isError, undefined)
  assert.equal(ok.content[0].text, UNTRUSTED_PREFIX)
  assert.ok(JSON.parse(ok.content[1].text).tabs.length >= 1)
})

test('mcp: server.registerTool stays backward compatible without annotations', () => {
  const s = new McpServer({ name: 'x', version: '1' })
  s.registerTool('a', { description: 'd', inputSchema: {} }, () => ({}))
  assert.equal(s.tools.get('a').annotations, undefined)
})
