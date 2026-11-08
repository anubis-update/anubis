const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createCdpBrowser, isHttpUrl } = require('../../app/lib/cdp-browser')

// A fake CDP client that records every send() and lets tests emit events. One
// instance is produced per launch handle, mirroring real cdpClient(handle).
function fakeClient () {
  const client = {
    sent: [],
    handlers: new Map(),
    closed: false,
    responders: {},
    send (method, params) {
      client.sent.push({ method, params: params || {} })
      const responder = client.responders[method]
      if (responder) return Promise.resolve(responder(params || {}))
      return Promise.resolve({})
    },
    on (method, cb) {
      if (!client.handlers.has(method)) client.handlers.set(method, [])
      client.handlers.get(method).push(cb)
    },
    emit (method, payload) {
      const list = client.handlers.get(method) || []
      for (const cb of list) cb(payload)
    },
    close () { client.closed = true },
    methods () { return client.sent.map(s => s.method) },
    paramsFor (method) { const hit = client.sent.find(s => s.method === method); return hit && hit.params },
    indexOf (method) { return client.sent.findIndex(s => s.method === method) }
  }
  return client
}

function fixture (overrides = {}) {
  const frames = []
  const events = []
  const launches = []
  const clients = []
  const launcher = async (opts) => {
    const handle = { id: opts && opts.id, killed: false, kill () { this.killed = true } }
    launches.push({ opts, handle })
    return handle
  }
  const cdpClient = async (handle) => {
    const client = fakeClient()
    client.handle = handle
    clients.push(client)
    return client
  }
  const cdp = createCdpBrowser({
    launcher,
    cdpClient,
    onFrame: (id, data) => frames.push({ id, data }),
    onEvent: (id, event) => events.push({ id, event }),
    log: { warn () {} },
    ...overrides
  })
  return { cdp, frames, events, launches, clients, launcher, cdpClient }
}

test('isHttpUrl accepts http(s) only', () => {
  for (const url of ['https://google.com', 'http://127.0.0.1:8000/']) assert.ok(isHttpUrl(url))
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hi', 'https://', 'x']) {
    assert.equal(isHttpUrl(url), false)
  }
})

test('constructor requires an injected launcher and cdpClient factory', () => {
  assert.throws(() => createCdpBrowser({ cdpClient: () => {} }), /launcher/)
  assert.throws(() => createCdpBrowser({ launcher: () => {} }), /cdpClient/)
})

test('open launches, enables Page, navigates and starts the screencast', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org', width: 800, height: 600 })
  assert.equal(f.launches.length, 1)
  assert.equal(f.clients.length, 1)
  const c = f.clients[0]
  const methods = c.methods()
  assert.ok(methods.includes('Page.enable'))
  assert.ok(methods.includes('Page.navigate'))
  assert.ok(methods.includes('Page.startScreencast'))
  assert.equal(c.paramsFor('Page.navigate').url, 'https://example.org')
  const screencast = c.paramsFor('Page.startScreencast')
  assert.equal(screencast.format, 'jpeg')
  assert.equal(screencast.maxWidth, 800)
  assert.equal(screencast.maxHeight, 600)
  assert.equal(f.cdp.count(), 1)
})

test('open rejects non-http targets and enforces the session cap', async () => {
  const f = fixture({ maxSessions: 2 })
  await assert.rejects(f.cdp.open({ id: 'a', url: 'file:///C:/x' }), /http/)
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  await f.cdp.open({ id: 'b', url: 'https://b.com' })
  await assert.rejects(f.cdp.open({ id: 'c', url: 'https://c.com' }), /Too many/)
  assert.equal(f.cdp.count(), 2)
})

test('open requires a valid id', async () => {
  const f = fixture()
  await assert.rejects(f.cdp.open({ url: 'https://a.com' }), /id/)
})

test('a second open for a live id navigates without relaunching', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  await f.cdp.open({ id: 'a', url: 'https://a.com/next' })
  assert.equal(f.launches.length, 1)
  const navs = f.clients[0].sent.filter(s => s.method === 'Page.navigate')
  assert.equal(navs.at(-1).params.url, 'https://a.com/next')
})

test('userAgent override is set before navigate', async () => {
  const f = fixture()
  const ua = 'Mozilla/5.0 (Macintosh) custom-override Safari/537.36'
  await f.cdp.open({ id: 'a', url: 'https://example.org', userAgent: ua })
  const c = f.clients[0]
  const iUa = c.indexOf('Network.setUserAgentOverride')
  const iNav = c.indexOf('Page.navigate')
  assert.ok(iUa >= 0, 'UA override was sent')
  assert.equal(c.paramsFor('Network.setUserAgentOverride').userAgent, ua)
  assert.ok(iUa < iNav, 'UA override set before navigate')
})

test('defaultUserAgent is applied before navigate when no override is given', async () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
  const f = fixture({ defaultUserAgent: ua })
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const c = f.clients[0]
  assert.equal(c.paramsFor('Network.setUserAgentOverride').userAgent, ua)
  assert.ok(c.indexOf('Network.setUserAgentOverride') < c.indexOf('Page.navigate'))
})

test('invalid userAgent override is ignored and falls back to the default', async () => {
  const def = 'Mozilla/5.0 default-ua Safari/537.36'
  const f = fixture({ defaultUserAgent: def })
  await f.cdp.open({ id: 'a', url: 'https://example.org', userAgent: 'bad\nua' })
  assert.equal(f.clients[0].paramsFor('Network.setUserAgentOverride').userAgent, def)
})

test('a screencast frame is decoded to a Buffer and acked', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const c = f.clients[0]
  const data = Buffer.from('jpeg-bytes').toString('base64')
  c.emit('Page.screencastFrame', { data, sessionId: 7 })
  assert.equal(f.frames.length, 1)
  assert.equal(f.frames[0].id, 'a')
  assert.ok(Buffer.isBuffer(f.frames[0].data))
  assert.equal(f.frames[0].data.toString(), 'jpeg-bytes')
  const ack = c.sent.find(s => s.method === 'Page.screencastFrameAck')
  assert.ok(ack, 'screencastFrameAck was sent')
  assert.equal(ack.params.sessionId, 7)
})

test('top-level frameNavigated emits a nav event with the live url', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  f.clients[0].emit('Page.frameNavigated', { frame: { url: 'https://example.org/next' } })
  assert.deepEqual(f.events.at(-1), { id: 'a', event: { t: 'nav', url: 'https://example.org/next' } })
})

test('subframe navigations do not emit a nav event', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  f.events.length = 0
  f.clients[0].emit('Page.frameNavigated', { frame: { url: 'https://ads.example/x', parentId: 'root' } })
  assert.equal(f.events.length, 0)
})

test('loading, title and error events are forwarded with the rbi shapes', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const c = f.clients[0]
  f.events.length = 0
  c.emit('Page.frameStartedLoading', {})
  c.emit('Page.loadEventFired', {})
  c.emit('Target.targetInfoChanged', { targetInfo: { title: 'Hello' } })
  c.emit('Page.loadingFailed', { errorText: 'ERR_NAME_NOT_RESOLVED' })
  assert.deepEqual(f.events.map(e => e.event), [
    { t: 'loading', state: 'start' },
    { t: 'loading', state: 'done' },
    { t: 'title', title: 'Hello' },
    { t: 'error', code: 'ERR_NAME_NOT_RESOLVED' }
  ])
})

test('input maps semantic events to the right Input.* methods', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const c = f.clients[0]
  c.sent.length = 0
  await f.cdp.input({ id: 'a', t: 'mouse', kind: 'down', x: 10, y: 20, button: 0, modifiers: 8 })
  let e = c.sent.at(-1)
  assert.equal(e.method, 'Input.dispatchMouseEvent')
  assert.equal(e.params.type, 'mousePressed')
  assert.equal(e.params.button, 'left')
  assert.equal(e.params.modifiers, 8)
  await f.cdp.input({ id: 'a', t: 'mouse', kind: 'wheel', x: 1, y: 2, dx: -3, dy: -4 })
  e = c.sent.at(-1)
  assert.equal(e.params.type, 'mouseWheel')
  assert.equal(e.params.deltaY, -4)
  await f.cdp.input({ id: 'a', t: 'key', kind: 'down', key: 'Enter' })
  e = c.sent.at(-1)
  assert.equal(e.method, 'Input.dispatchKeyEvent')
  assert.equal(e.params.type, 'keyDown')
  assert.equal(e.params.key, 'Enter')
  await f.cdp.input({ id: 'a', t: 'key', kind: 'char', key: 'q' })
  e = c.sent.at(-1)
  assert.equal(e.params.type, 'char')
  assert.equal(e.params.text, 'q')
})

test('right-button and middle-button presses map correctly', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const c = f.clients[0]
  await f.cdp.input({ id: 'a', t: 'mouse', kind: 'up', x: 1, y: 1, button: 2 })
  assert.equal(c.sent.at(-1).params.button, 'right')
  await f.cdp.input({ id: 'a', t: 'mouse', kind: 'up', x: 1, y: 1, button: 1 })
  assert.equal(c.sent.at(-1).params.button, 'middle')
})

test('input is dropped for unknown sessions and does not throw', async () => {
  const f = fixture()
  await f.cdp.input({ id: 'missing', t: 'mouse', kind: 'move', x: 1, y: 1 })
  assert.equal(f.frames.length, 0)
})

test('resize sets device metrics and restarts the screencast', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org', width: 800, height: 600 })
  const c = f.clients[0]
  c.sent.length = 0
  await f.cdp.resize({ id: 'a', width: 1024, height: 768, dpr: 2 })
  const metrics = c.paramsFor('Emulation.setDeviceMetricsOverride')
  assert.equal(metrics.width, 1024)
  assert.equal(metrics.height, 768)
  assert.equal(metrics.deviceScaleFactor, 2)
  assert.equal(metrics.mobile, false)
  assert.ok(c.indexOf('Page.stopScreencast') < c.indexOf('Page.startScreencast'))
})

test('tab retarget and viewport resize cannot start the same screencast concurrently', async () => {
  const raw = { send: async () => ({ targetInfo: { url: 'https://example.org/new', title: 'New tab' } }) }
  const clients = []
  const warnings = []
  let releaseEnable
  let reachedEnable
  const enableReached = new Promise(resolve => { reachedEnable = resolve })
  const enableGate = new Promise(resolve => { releaseEnable = resolve })
  const f = fixture({
    launcher: async () => ({ client: raw, close () {} }),
    cdpClient: async (handle, { targetId = 'initial' } = {}) => {
      const client = fakeClient()
      client.targetId = targetId
      let streaming = false
      client.responders['Page.startScreencast'] = () => {
        if (streaming) throw new Error('Screencast is already active')
        streaming = true
        return {}
      }
      client.responders['Page.stopScreencast'] = () => { streaming = false; return {} }
      if (targetId === 'new') {
        client.responders['Page.enable'] = async () => { reachedEnable(); await enableGate; return {} }
      }
      clients.push(client)
      return client
    },
    log: { warn: (...args) => warnings.push(args.join(' ')) }
  })
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  const retarget = f.cdp.activateTarget(raw, 'new')
  await enableReached
  const resize = f.cdp.resize({ id: 'a', width: 1200, height: 900 })
  await new Promise(resolve => setImmediate(resolve))
  releaseEnable()
  await Promise.all([retarget, resize])
  assert.deepEqual(warnings, [])
  assert.equal(f.cdp._sessions.get('a').client, clients[1])
  assert.equal(clients[1].paramsFor('Emulation.setDeviceMetricsOverride').width, 1280)
  assert.equal(clients[1].sent.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1).params.width, 1200)
  f.cdp.disposeAll()
})

test('nav goto/reload issue the matching CDP calls', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const c = f.clients[0]
  c.sent.length = 0
  await f.cdp.nav({ id: 'a', action: 'goto', url: 'https://a.com/x' })
  assert.equal(c.paramsFor('Page.navigate').url, 'https://a.com/x')
  await f.cdp.nav({ id: 'a', action: 'reload' })
  assert.ok(c.methods().includes('Page.reload'))
})

test('nav back and forward walk the navigation history', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const c = f.clients[0]
  c.responders['Page.getNavigationHistory'] = () => ({
    currentIndex: 1,
    entries: [{ id: 10 }, { id: 11 }, { id: 12 }]
  })
  c.sent.length = 0
  await f.cdp.nav({ id: 'a', action: 'back' })
  assert.equal(c.paramsFor('Page.navigateToHistoryEntry').entryId, 10)
  c.sent.length = 0
  await f.cdp.nav({ id: 'a', action: 'forward' })
  assert.equal(c.paramsFor('Page.navigateToHistoryEntry').entryId, 12)
})

test('nav back at the start of history is a no-op', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const c = f.clients[0]
  c.responders['Page.getNavigationHistory'] = () => ({ currentIndex: 0, entries: [{ id: 10 }] })
  c.sent.length = 0
  await f.cdp.nav({ id: 'a', action: 'back' })
  assert.equal(c.indexOf('Page.navigateToHistoryEntry'), -1)
})

test('nav is dropped for unknown sessions', async () => {
  const f = fixture()
  await f.cdp.nav({ id: 'missing', action: 'reload' })
  assert.equal(f.clients.length, 0)
})

test('exportCookies returns the cookies array from Network.getAllCookies', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const stored = [{ name: 'sid', value: '1', domain: '.a.com', path: '/' }]
  f.clients[0].responders['Network.getAllCookies'] = () => ({ cookies: stored })
  const cookies = await f.cdp.exportCookies({ id: 'a' })
  assert.deepEqual(cookies, stored)
})

test('exportCookies throws for an unknown session', async () => {
  const f = fixture()
  await assert.rejects(f.cdp.exportCookies({ id: 'missing' }), /not found/)
})

test('importCookies builds urls, calls Network.setCookies and skips broken entries', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const count = await f.cdp.importCookies({
    id: 'a',
    cookies: [
      { name: 'sid', value: 'abc', domain: '.example.com', path: '/app', secure: true, httpOnly: true, expirationDate: 123, sameSite: 'None' },
      { name: 'plain', value: 'y', domain: 'plain.org' },
      { value: 'no-name', domain: 'x.com' },
      { name: 'no-domain', value: 'z' },
      null
    ]
  })
  assert.equal(count, 2)
  const sent = f.clients[0].paramsFor('Network.setCookies').cookies
  assert.equal(sent.length, 2)
  assert.equal(sent[0].url, 'https://example.com/app')
  assert.equal(sent[0].name, 'sid')
  assert.equal(sent[0].secure, true)
  assert.equal(sent[0].httpOnly, true)
  assert.equal(sent[0].expires, 123)
  assert.equal(sent[0].sameSite, 'None')
  assert.equal(sent[1].url, 'http://plain.org/')
})

test('export then import round-trips a cookie', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const original = [{ name: 'sid', value: '1', domain: 'a.com', path: '/', secure: true }]
  f.clients[0].responders['Network.getAllCookies'] = () => ({ cookies: original })
  const exported = await f.cdp.exportCookies({ id: 'a' })
  const count = await f.cdp.importCookies({ id: 'a', cookies: exported })
  assert.equal(count, 1)
  assert.equal(f.clients[0].paramsFor('Network.setCookies').cookies[0].name, 'sid')
})

test('importCookies throws for an unknown session and returns 0 for non-arrays', async () => {
  const f = fixture()
  await assert.rejects(f.cdp.importCookies({ id: 'missing', cookies: [] }), /not found/)
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  assert.equal(await f.cdp.importCookies({ id: 'a', cookies: 'nope' }), 0)
})

test('close stops the screencast, closes the handle and drops the session', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  const c = f.clients[0]
  const handle = f.launches[0].handle
  f.cdp.close({ id: 'a' })
  assert.ok(c.methods().includes('Page.stopScreencast'))
  assert.equal(c.closed, true)
  assert.equal(handle.killed, true)
  assert.equal(f.cdp.count(), 0)
  // a late frame after close must not forward anything
  c.emit('Page.screencastFrame', { data: Buffer.from('x').toString('base64'), sessionId: 1 })
  assert.equal(f.frames.length, 0)
})

test('close is a no-op for an unknown session', async () => {
  const f = fixture()
  f.cdp.close({ id: 'missing' })
  assert.equal(f.cdp.count(), 0)
})

test('a failed open reaps the just-launched browser handle so nothing leaks', async () => {
  const f = fixture({ cdpClient: async () => { throw new Error('transport closed') } })
  await assert.rejects(f.cdp.open({ id: 'a', url: 'https://a.com' }), /transport closed/)
  assert.equal(f.launches.length, 1, 'the browser was launched')
  assert.equal(f.launches[0].handle.killed, true, 'the launched browser was reaped')
  assert.equal(f.cdp.count(), 0, 'no session is left behind')
})

test('an open that throws after the client attaches reaps and clears the session', async () => {
  const badClient = {
    sent: [],
    closed: false,
    send (method, params) { this.sent.push({ method, params: params || {} }); return Promise.resolve({}) },
    on () { throw new Error('wire failed') },
    close () { this.closed = true }
  }
  const f = fixture({ cdpClient: async () => badClient })
  await assert.rejects(f.cdp.open({ id: 'a', url: 'https://a.com' }), /wire failed/)
  assert.equal(f.cdp.count(), 0, 'no session is left behind')
  assert.equal(badClient.closed, true, 'the attached client was closed on reap')
  assert.equal(f.launches[0].handle.killed, true, 'the launched browser was reaped')
})

test('disposeAll closes every live session', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://a.com' })
  await f.cdp.open({ id: 'b', url: 'https://b.com' })
  assert.equal(f.cdp.count(), 2)
  f.cdp.disposeAll()
  assert.equal(f.cdp.count(), 0)
  for (const c of f.clients) assert.equal(c.closed, true)
})

test('poolSize is exposed as 0 for interface parity', async () => {
  const f = fixture()
  assert.equal(f.cdp.poolSize(), 0)
})

test('open passes browser=chrome to the launcher by default and for engine chrome', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org' })
  await f.cdp.open({ id: 'b', url: 'https://example.org', engine: 'chrome' })
  assert.equal(f.launches[0].opts.browser, 'chrome')
  assert.equal(f.launches[1].opts.browser, 'chrome')
})

test('open passes browser=edge to the launcher for engine edge', async () => {
  const f = fixture()
  await f.cdp.open({ id: 'a', url: 'https://example.org', engine: 'edge' })
  assert.equal(f.launches[0].opts.browser, 'edge')
})
