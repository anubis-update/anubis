const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer, WebSocket } = require('ws')
const { createBrowserApi } = require('../../app/lib/browser-api')
const { createControlChannel, createControlManager, defaultPost, REMOTE_ACTOR } = require('../../app/lib/browser-api/control-channel')
const { createControlStore } = require('../../app/lib/browser-api/control-channel-store')
const U = require('../../app/lib/browser-api/control-channel-util')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')
const { createTokenStore } = require('../../app/lib/browser-api/v1-api')
const { createFakeCdp } = require('./browser-hub-fake-cdp')

const stubPath = path.resolve(__dirname, '../../../../../anubis-control-center/src/server.js')
const hasStub = fs.existsSync(stubPath)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(15)
  }
  return false
}

function makeApi (aegis) {
  const client = createFakeCdp({
    'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1', url: 'https://a.test/' }] },
    'Target.attachToTarget': (p) => ({ sessionId: 'S_' + p.targetId })
  })
  const files = new Map()
  const api = createBrowserApi({
    aegis,
    launchBrowser: async () => ({ client, userDataDir: 'u', close () {} }),
    resolveSourceDir: () => null,
    auditFs: { append: (n, l) => files.set(n, (files.get(n) || '') + l), read: (n) => files.get(n) || '', list: () => [...files.keys()] },
    historyReader: { available: false },
    deviceInfo: () => ({ deviceId: 'test-pc' })
  })
  const auditRecords = () => [...files.values()].join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { api, auditRecords }
}

function memStore (protect) {
  let doc = null
  const io = { read: () => doc, write: (d) => { doc = d } }
  return { store: createControlStore({ io, protect: protect && protect.p, unprotect: protect && protect.u }), raw: () => doc }
}

async function setup ({ opts = {}, ccOpts = {}, aegis } = {}) {
  const { createControlCenter } = require(stubPath)
  const cc = createControlCenter({ WebSocketServer, ...ccOpts })
  await cc.start()
  const { api, auditRecords } = makeApi(aegis)
  const ms = memStore({ p: (s) => 'enc:' + s, u: (s) => s.replace(/^enc:/, '') })
  const delays = []
  const timers = {
    setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms) },
    clearTimeout,
    setInterval,
    clearInterval
  }
  const ch = createControlChannel({
    api,
    store: ms.store,
    WebSocket,
    post: defaultPost,
    enabled: true,
    url: cc.url(),
    allowInsecureLocal: true,
    random: () => 0,
    timers,
    deviceInfo: () => ({ deviceId: 'test-pc', anubisVersion: '1.0.0' }),
    ...opts
  })
  const enrolled = async () => {
    const r = await ch.enroll({ token: cc.createEnrollmentToken() })
    ch.connect()
    assert.ok(await until(() => cc.isOnline(r.deviceId)), 'device online')
    return r
  }
  const stop = async () => { ch.dispose(); await cc.stop() }
  return { cc, api, auditRecords, ch, ms, delays, enrolled, stop }
}

test('url policy: wss only, ws only for localhost when allowed', () => {
  assert.equal(U.parseCcUrl('wss://cc.example/ws/v1/device').protocol, 'wss:')
  assert.throws(() => U.parseCcUrl('ws://cc.example/x', { allowInsecureLocal: true }), { code: 'INSECURE_TRANSPORT' })
  assert.throws(() => U.parseCcUrl('ws://localhost:1/x'), { code: 'INSECURE_TRANSPORT' })
  assert.equal(U.parseCcUrl('ws://127.0.0.1:1/x', { allowInsecureLocal: true }).hostname, '127.0.0.1')
  assert.throws(() => U.parseCcUrl('https://cc.example/'), { code: 'INSECURE_TRANSPORT' })
  assert.throws(() => U.parseCcUrl('wss://u:p@cc.example/'), { code: 'INVALID_URL' })
  assert.throws(() => U.parseCcUrl('nonsense'), { code: 'INVALID_URL' })
  assert.equal(U.enrollUrl(new URL('wss://cc.example/ws/v1/device?x=1')).href, 'https://cc.example/enroll')
})

test('signed Aegis commands require the operator role and use the device service', { skip: !hasStub }, async () => {
  const calls = []
  const context = await setup({
    aegis: (action, params) => { calls.push({ action, params }); return { revision: 3 } }
  })
  try {
    const { deviceId } = await context.enrolled()
    const denied = await context.cc.sendCommand(deviceId, { command: 'aegis.settings', params: {} })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'FORBIDDEN')
    assert.equal(calls.length, 0)
    const allowed = await context.cc.sendCommand(deviceId, { command: 'aegis.settings', params: {}, role: 'operator' })
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(allowed.result.revision, 3)
    assert.deepEqual(calls, [{ action: 'settings', params: {} }])
    const invalid = await context.cc.sendCommand(deviceId, { command: 'aegis.start', params: { confirmed: false }, role: 'operator' })
    assert.equal(invalid.error.code, 'INVALID_REQUEST')
    assert.equal(calls.length, 1)
  } finally { await context.stop() }
})

test('util: canonical, sign/verify, scrub', () => {
  assert.equal(U.canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}')
  const kp = U.generateKeyPair()
  const sig = U.sign(kp.privateKey, 'hello')
  assert.ok(U.verify(kp.publicKey, 'hello', sig))
  assert.ok(!U.verify(kp.publicKey, 'hellO', sig))
  assert.ok(!U.verify('bogus', 'hello', sig))
  const s = U.scrub({ a: { cookies: [{ value: 'x' }], Password: 'p', ok: 1 }, list: [{ authorization: 'Bearer z' }] })
  assert.deepEqual(s, { a: { cookies: '[redacted]', Password: '[redacted]', ok: 1 }, list: [{ authorization: '[redacted]' }] })
})

test('a malformed control-center identity fails closed instead of looking unenrolled', () => {
  for (const doc of [
    [],
    'identity',
    1,
    { v: 2, deviceId: 'd', privateKey: 'wrapped' },
    { deviceId: 'd', privateKey: 'wrapped' }
  ]) {
    const store = createControlStore({ io: { read: () => doc, write () {} } })
    assert.throws(() => store.identity(), { code: 'STATE_READ_FAILED' })
    assert.throws(() => store.identity(), { code: 'STATE_READ_FAILED' })
    assert.throws(() => store.killed(), { code: 'STATE_READ_FAILED' })
  }
  const blankKey = createControlStore({
    io: { read: () => ({ v: 1, deviceId: 'd', privateKey: 'wrapped' }), write () {} },
    unprotect: () => ''
  })
  assert.throws(() => blankKey.identity(), { code: 'STATE_READ_FAILED' })
  const absent = createControlStore({ io: { read: () => null, write () {} } })
  assert.equal(absent.identity(), null)
  assert.equal(absent.killed(), false)
})

test('store: private key is protected at rest and absent from status/public data', () => {
  const { store, raw } = memStore({ p: (s) => 'enc:' + s, u: (s) => s.replace(/^enc:/, '') })
  assert.equal(store.identity(), null)
  store.saveIdentity({ deviceId: 'd', keyId: 'k', publicKey: 'pub', privateKey: 'PRIVATE', serverPublicKey: 's', url: 'wss://x/' })
  assert.equal(raw().privateKey, 'enc:PRIVATE')
  assert.equal(store.identity().privateKey, 'PRIVATE')
  assert.ok(store.isProtected())
  store.setKilled(true)
  assert.ok(store.killed())
  assert.equal(store.identity().deviceId, 'd')
  store.clear()
  assert.equal(store.identity(), null)
})

test('store write/decryption failures preserve the previous identity and remain explicit', () => {
  let doc = null
  let broken = false
  const store = createControlStore({
    io: { read: () => doc, write: next => { if (broken) throw new Error('disk error'); doc = next } }
  })

  test('emergency stop disconnects even if persisting its flag fails', () => {
    const { EventEmitter } = require('node:events')
    let closed = false
    const { api } = makeApi()
    class Socket extends EventEmitter {
      send () {}
      close () { closed = true }
    }
    const channel = createControlChannel({
      api,
      enabled: true,
      WebSocket: Socket,
      store: {
        identity: () => ({ deviceId: 'test', url: 'wss://cc.example/ws/v1/device' }),
        killed: () => false,
        isProtected: () => true,
        setKilled: () => { throw Object.assign(new Error('Cannot save kill flag'), { code: 'STATE_WRITE_FAILED' }) }
      }
    })
    try {
      channel.connect()
      assert.throws(() => channel.kill(), { code: 'STATE_WRITE_FAILED' })
      assert.equal(closed, true)
      assert.equal(channel.status().state, 'killed')
    } finally { channel.dispose(); api.shutdown() }
  })
  store.saveIdentity({ deviceId: 'original', keyId: 'k', publicKey: 'pub', privateKey: 'PRIVATE', serverPublicKey: 's', url: 'wss://x/' })
  broken = true
  assert.throws(() => store.clear(), { code: 'STATE_WRITE_FAILED' })
  assert.equal(store.identity().deviceId, 'original')
  assert.throws(() => store.setKilled(true), { code: 'STATE_WRITE_FAILED' })
  assert.equal(store.killed(), false)
  const locked = createControlStore({ io: { read: () => doc, write () {} }, unprotect: () => { throw new Error('cannot unlock') } })
  assert.throws(() => locked.identity(), { code: 'STATE_READ_FAILED' })
  const unreadable = createControlStore({ io: { read: () => { throw new Error('cannot read') }, write () {} } })
  assert.throws(() => unreadable.identity(), { code: 'STATE_READ_FAILED' })
})

test('Control Center settings persist live, reject insecure URLs and respect locks and identity pins', async () => {
  let saved = null
  let broken = false
  let identity = false
  let killed = false
  let connects = 0
  let disposed = 0
  let enrolledUrl
  const options = {
    io: { read: () => saved, write: next => { if (broken) throw new Error('disk error'); saved = next } },
    createChannel: settings => ({
      status: () => ({ enabled: settings.enabled, enrolled: identity, killed, url: enrolledUrl || settings.url }),
      connect: () => { connects++ },
      dispose: () => { disposed++ },
      enroll: async () => { identity = true; enrolledUrl = settings.url; return { enrolled: true } },
      forget: () => { identity = false; enrolledUrl = undefined },
      disconnect () {},
      kill: () => { killed = true },
      resume: () => { killed = false }
    })
  }
  const manager = createControlManager(options)
  const settings = { enabled: true, url: 'wss://cc.example/ws/v1/device', autoConnect: true }
  assert.equal(manager.status().enabled, false)
  assert.throws(() => manager.configure({ ...settings, url: 'ws://cc.example/ws/v1/device' }), { code: 'INSECURE_TRANSPORT' })
  assert.throws(() => manager.configure({ ...settings, url: 'wss://cc.example/wrong' }), { code: 'INVALID_URL' })
  manager.configure(settings)
  assert.deepEqual(saved, settings)
  assert.equal(disposed, 1)
  await manager.enroll({ token: 'not-persisted-enrollment' })
  assert.ok(!JSON.stringify(saved).includes('not-persisted-enrollment'))
  await assert.rejects(manager.enroll({ token: 'duplicate' }), { code: 'IDENTITY_CONFLICT' })
  const reloaded = createControlManager(options)
  assert.equal(connects, 1)
  broken = true
  assert.throws(() => reloaded.configure({ ...settings, enabled: false }), { code: 'STATE_WRITE_FAILED' })
  assert.equal(reloaded.status().enabled, true)
  broken = false
  reloaded.configure({ ...settings, enabled: false })
  assert.throws(() => reloaded.configure({ ...settings, url: 'wss://other.example/ws/v1/device' }), { code: 'IDENTITY_CONFLICT' })
  assert.throws(() => reloaded.connect(), { code: 'DISABLED' })
  const restricted = createControlManager({ ...options, locked: { enabled: false } })
  assert.throws(() => restricted.configure(settings), { code: 'POLICY_DENIED' })
  const stopped = createControlManager({ ...options, forceDisabled: true })
  assert.throws(() => stopped.configure(settings), { code: 'POLICY_DENIED' })
})

test('disabled by default / insecure url refused / not enrolled', async () => {
  const { api } = makeApi()
  const { store } = memStore()
  const off = createControlChannel({ api, store, WebSocket })
  assert.equal(off.status().state, 'disabled')
  assert.throws(() => off.connect(), { code: 'DISABLED' })
  await assert.rejects(off.enroll({ token: 'abcdefgh1234' }), { code: 'DISABLED' })
  let posted = false
  const bad = createControlChannel({ api, store, WebSocket, enabled: true, url: 'ws://cc.example/ws', post: async () => { posted = true } })
  await assert.rejects(bad.enroll({ token: 'abcdefgh1234' }), { code: 'INSECURE_TRANSPORT' })
  assert.equal(posted, false)
  const ok = createControlChannel({ api, store, WebSocket, enabled: true, url: 'wss://cc.example/ws' })
  assert.throws(() => ok.connect(), { code: 'NOT_ENROLLED' })
})

test('hub controller: controlCenter.* actions, disabled and enabled', async () => {
  const { api } = makeApi()
  const tokens = createTokenStore()
  const off = createBrowserHubController({ api, tokens })
  assert.deepEqual((await off.handle('controlCenter.status')).result, { enabled: false, state: 'disabled', enrolled: false })
  assert.equal((await off.handle('controlCenter.connect')).error.code, 'DISABLED')
  const { store } = memStore()
  const ch = createControlChannel({ api, store, WebSocket, enabled: true, url: 'wss://cc.example/ws' })
  const on = createBrowserHubController({ api, tokens, controlCenter: ch })
  assert.equal((await on.handle('controlCenter.status')).result.state, 'idle')
  assert.equal((await on.handle('controlCenter.connect')).error.code, 'NOT_ENROLLED')
  assert.equal((await on.handle('controlCenter.enroll', {})).error.code, 'INVALID_REQUEST')
  assert.equal((await on.handle('controlCenter.kill')).result.state, 'killed')
  assert.equal((await on.handle('controlCenter.connect')).error.code, 'KILLED')
  assert.equal((await on.handle('controlCenter.resume')).result.killed, false)
  assert.equal((await on.handle('status')).result.controlCenter.state, 'idle')
})

test('loopback: enroll, signed-challenge auth, command → result, audited as remote', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    const st = t.ch.status()
    assert.equal(st.state, 'connected')
    assert.equal(st.enrolled, true)
    assert.equal(st.keyProtected, true)
    assert.ok(!JSON.stringify(st).includes(t.ms.raw().privateKey))
    assert.equal(t.ms.raw().privateKey.startsWith('enc:'), true)

    const res = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities' })
    assert.equal(res.ok, true, JSON.stringify(res))

    const rec = t.auditRecords().find((x) => x.command === 'api.capabilities')
    assert.ok(rec)
    assert.equal(rec.actor.kind, 'remote')
    assert.equal(rec.transport, 'control-center')
    assert.equal(REMOTE_ACTOR.role, 'agent')
  } finally { await t.stop() }
})

test('loopback: default-deny and hard blocks hold for remote commands, all audited', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    const admin = { id: 'ui', role: 'admin', kind: 'admin' }
    const l = await t.api.dispatcher.execute({ v: 1, requestId: 'req_launch01', command: 'browser.launch', params: { engine: 'chrome' } }, admin)
    assert.equal(l.ok, true, JSON.stringify(l))
    const bid = l.result.browserId
    const tl = await t.api.dispatcher.execute({ v: 1, requestId: 'req_tabs0001', command: 'tab.list', browserId: bid, params: {} }, admin)
    const tabId = tl.result.tabs[0].tabId
    const denied = await t.cc.sendCommand(r.deviceId, { command: 'storage.clear', tabId, params: { origin: 'https://a.test' } })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'POLICY_DENIED', JSON.stringify(denied))
    for (const command of ['page.evaluate', 'cookies.export', 'passwords.import', 'credential.fill', 'storage.get']) {
      const x = await t.cc.sendCommand(r.deviceId, { command, params: {}, tabId: 't_abcdefgh' })
      assert.equal(x.error.code, 'POLICY_DENIED', command)
    }
    const recs = t.auditRecords()
    for (const command of ['storage.clear', 'page.evaluate', 'cookies.export', 'passwords.import', 'credential.fill', 'storage.get']) {
      assert.ok(recs.some((x) => x.command === command && x.actor.kind === 'remote'), 'audited ' + command)
    }
  } finally { await t.stop() }
})

test('loopback: forged / replayed / expired frames are not executed', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    const before = t.auditRecords().length
    // tampered after signing → signature mismatch → dropped silently (no result)
    await assert.rejects(t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', timeoutMs: 300 }, { tamper: (f) => ({ ...f, command: 'browser.list' }) }), { message: 'TIMEOUT' })
    assert.ok(t.auditRecords().length > before)
    assert.ok(t.auditRecords().some((x) => x.decision && x.decision.rule === 'bad-signature'))
    // bad request id → rejected ack
    const bad = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', id: 'x' })
    assert.equal(bad.ok, false)
    // expired deadline → rejected
    const late = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', timeoutMs: -1000 })
    assert.equal(late.error.code, 'TIMEOUT')
    // duplicate id → cached result, ack duplicate (not re-executed)
    const a = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', id: 'dup_request_1' })
    assert.equal(a.ok, true)
  } finally { await t.stop() }
})

test('loopback: enrollment token is single use; wrong token fails', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const token = t.cc.createEnrollmentToken()
    await t.ch.enroll({ token })
    await assert.rejects(t.ch.enroll({ token }), { code: 'ENROLL_FAILED' })
    await assert.rejects(t.ch.enroll({ token: 'enr_not_a_real_token' }), (e) => e.code === 'ENROLL_FAILED' && !e.message.includes('enr_not'))
  } finally { await t.stop() }
})

test('loopback: kill switch disconnects, persists, blocks connect; resume restores', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    t.ch.kill()
    assert.ok(await until(() => !t.cc.isOnline(r.deviceId)))
    assert.equal(t.ch.status().state, 'killed')
    assert.throws(() => t.ch.connect(), { code: 'KILLED' })
    const again = createControlChannel({ api: t.api, store: t.ms.store, WebSocket, enabled: true, url: t.cc.url(), allowInsecureLocal: true })
    assert.throws(() => again.connect(), { code: 'KILLED' })
    t.ch.resume()
    t.ch.connect()
    assert.ok(await until(() => t.cc.isOnline(r.deviceId)))
  } finally { await t.stop() }
})

test('loopback: reconnect with jittered backoff after drop; revoked device stops', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    t.delays.length = 0
    t.cc.revokeDevice(r.deviceId)
    assert.ok(await until(() => t.ch.status().state === 'revoked'))
    await sleep(400)
    assert.equal(t.cc.isOnline(r.deviceId), false)
    assert.equal(t.delays.filter((d) => d !== 10000).length, 0, 'no reconnect after revoke')
  } finally { await t.stop() }

  const t2 = await setup()
  try {
    const r = await t2.enrolled()
    t2.delays.length = 0
    const first = t2.ch.status()
    assert.equal(first.attempt, 0)
    await t2.cc.stop()
    assert.ok(await until(() => t2.ch.status().state === 'backoff' || t2.ch.status().attempt > 0))
    assert.ok(t2.delays.some((d) => d >= 250 && d <= 1000), JSON.stringify(t2.delays))
    assert.ok(r.deviceId)
  } finally { t2.ch.dispose() }
})

test('loopback: remote events are streamed with secrets scrubbed', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    t.api.events.emit('browser.test', { data: { cookies: 'SECRET', note: 'x' } })
    assert.ok(await until(() => t.cc.events().length > 0))
    const ev = t.cc.events()[0]
    assert.equal(ev.deviceId, r.deviceId)
    assert.ok(!JSON.stringify(ev).includes('SECRET'))
  } finally { await t.stop() }
})

test('loopback: takeover rejects agent commands, allows operator, releases', { skip: !hasStub }, async () => {
  const t = await setup()
  try {
    const r = await t.enrolled()
    assert.equal(t.ch.status().takeover, false)
    assert.ok(t.cc.setTakeover(r.deviceId, true, 'alice'))
    assert.ok(await until(() => t.ch.status().takeover === true))
    const blocked = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'TAKEOVER')
    const explicit = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', role: 'agent' })
    assert.equal(explicit.error.code, 'TAKEOVER')
    const op = await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities', role: 'operator' })
    assert.equal(op.ok, true, JSON.stringify(op))
    assert.ok(t.auditRecords().some((x) => x.decision && x.decision.rule === 'takeover'))
    t.cc.setTakeover(r.deviceId, false)
    assert.ok(await until(() => t.ch.status().takeover === false))
    assert.equal((await t.cc.sendCommand(r.deviceId, { command: 'api.capabilities' })).ok, true)
  } finally { await t.stop() }
})
