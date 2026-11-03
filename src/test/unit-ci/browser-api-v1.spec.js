const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { WebSocketServer, WebSocket } = require('ws')
const { createBrowserApi } = require('../../app/lib/browser-api')
const { createV1Server, createTokenStore } = require('../../app/lib/browser-api/v1-api')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

function setup () {
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId })
  })
  const files = new Map()
  const api = createBrowserApi({
    launchBrowser: async () => ({ client, userDataDir: 'u', close () {} }),
    resolveSourceDir: () => null,
    auditFs: { append: (n, l) => files.set(n, (files.get(n) || '') + l), read: (n) => files.get(n) || '', list: () => [...files.keys()] },
    historyReader: { available: false }
  })
  const tokens = createTokenStore()
  const srv = createV1Server({ api, tokens, WebSocketServer, allowedOrigins: ['http://ok.local'] })
  return { api, tokens, srv }
}

function req (port, { method = 'GET', path = '/v1/capabilities', headers = {}, body, rawHost } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: rawHost || `127.0.0.1:${port}`, ...headers } }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { let j; try { j = JSON.parse(d) } catch {} resolve({ status: res.statusCode, json: j, text: d }) })
    })
    r.on('error', reject)
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body))
    r.end()
  })
}

test('v1: auth, Host, Origin, content-type, body limit', async () => {
  const { tokens, srv } = setup()
  const { port, host } = await srv.start()
  assert.equal(host, '127.0.0.1')
  try {
    const t = tokens.issue('admin')
    const auth = { authorization: 'Bearer ' + t }
    assert.equal((await req(port)).status, 401)
    assert.equal((await req(port, { headers: { authorization: 'Bearer nope' } })).status, 401)
    assert.equal((await req(port, { headers: auth, rawHost: 'evil.com' })).status, 403)
    assert.equal((await req(port, { headers: { ...auth, origin: 'http://evil.com' } })).status, 403)
    assert.equal((await req(port, { headers: { ...auth, origin: 'http://ok.local' } })).status, 200)
    const cap = await req(port, { headers: auth })
    assert.equal(cap.status, 200)
    assert.equal(cap.json.result.apiVersion, 1)
    assert.equal(cap.text.includes(t), false)
    assert.equal((await req(port, { method: 'POST', path: '/v1/commands', headers: auth, body: '{}' })).status, 415)
    const ct = { ...auth, 'content-type': 'application/json' }
    assert.equal((await req(port, { method: 'POST', path: '/v1/commands', headers: ct, body: '{bad' })).status, 400)
    assert.equal((await req(port, { method: 'POST', path: '/v1/commands', headers: ct, body: 'x'.repeat(1024 * 1024 + 10) }).catch(() => ({ status: 413 }))).status, 413)
    assert.equal((await req(port, { path: '/v1/nope', headers: auth })).status, 404)
  } finally { await srv.stop() }
})

test('v1: commands, status mapping, role gating, confirmations need local token', async () => {
  const { api, tokens, srv } = setup()
  const { port } = await srv.start()
  try {
    const admin = { authorization: 'Bearer ' + tokens.issue('admin'), 'content-type': 'application/json' }
    const agent = { authorization: 'Bearer ' + tokens.issue('agent'), 'content-type': 'application/json' }
    const l = await req(port, { method: 'POST', path: '/v1/commands/browser.launch', headers: admin, body: { requestId: 'req_launch01', params: { engine: 'chrome' } } })
    assert.equal(l.status, 200, l.text)
    const b = l.json.result.browserId
    const tabs = await req(port, { method: 'POST', path: '/v1/commands', headers: agent, body: { v: 1, requestId: 'req_tabs0001', command: 'tab.list', browserId: b, params: {} } })
    assert.equal(tabs.status, 200, tabs.text)
    const denied = await req(port, { method: 'POST', path: '/v1/commands', headers: agent, body: { v: 1, requestId: 'req_eval0001', command: 'cookies.export', browserId: b, params: {} } })
    assert.equal(denied.status, 403)
    assert.equal((await req(port, { method: 'POST', path: '/v1/commands', headers: agent, body: { v: 1, requestId: 'req_nf000001', command: 'tab.list', browserId: 'b_zzzzzzzz', params: {} } })).status, 404)
    assert.equal((await req(port, { path: '/v1/audit', headers: agent })).status, 403)
    const audit = await req(port, { path: '/v1/audit', headers: admin })
    assert.equal(audit.status, 200)
    assert.ok(audit.json.result.records.length > 0)
    assert.equal((await req(port, { method: 'POST', path: '/v1/confirmations/c1', headers: admin, body: { approve: true } })).status, 403)
    assert.equal((await req(port, { method: 'POST', path: '/v1/confirmations/c1', headers: { ...admin, 'x-anubis-local-token': 'guess' }, body: { approve: true } })).status, 403)
    assert.equal((await req(port, { method: 'DELETE', path: '/v1/requests/req_unknown1', headers: admin })).status, 404)
    assert.ok(api.confirmations.localToken())
  } finally { await srv.stop() }
})

test('v1: WS events with since replay; unauthenticated upgrade rejected', async () => {
  const { api, tokens, srv } = setup()
  const { port } = await srv.start()
  try {
    api.events.emit('tab.created', { browserId: 'b_abcd1234', data: { n: 1 } })
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events`)
      ws.on('open', resolve)
      ws.on('error', reject)
    }))
    const t = tokens.issue('agent')
    const msgs = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events?since=0`, { headers: { authorization: 'Bearer ' + t } })
    await new Promise((resolve, reject) => { ws.on('message', (m) => { msgs.push(JSON.parse(String(m))); resolve() }); ws.on('error', reject) })
    assert.equal(msgs[0].event, 'tab.created')
    ws.close()
  } finally { await srv.stop() }
})

test('token store: expiry and revoke', () => {
  let t = 1000
  const s = createTokenStore({ now: () => t })
  const tok = s.issue('agent', 100)
  assert.equal(s.verify(tok).role, 'agent')
  t += 200
  assert.equal(s.verify(tok), null)
  const tok2 = s.issue('admin')
  s.revokeAll()
  assert.equal(s.verify(tok2), null)
  assert.equal(s.verify(''), null)
})
