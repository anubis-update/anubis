/**
 * Control Center channel (device side, SPEC-v1 Â§11). The device dials OUT over
 * wss://, authenticates by signing a server challenge with its Ed25519 key,
 * and executes signed `cmd` frames ONLY through api.dispatcher.execute with a
 * 'remote' actor, so local policy / default-deny / audit apply. Confirmations
 * are never answered here: they stay in the local UI. Disabled unless the
 * caller sets enabled; a persistent kill switch stops everything.
 */

const crypto = require('node:crypto')
const U = require('./control-channel-util')

const REMOTE_ACTOR = Object.freeze({ id: 'remote', role: 'agent', kind: 'remote', transport: 'control-center' })
// Hard blocks regardless of policy: cookie/credential material and arbitrary JS must not be driven remotely.
const REMOTE_BLOCKED = [/^cookies\./, /^passwords\./, /^credential\./, /^page\.evaluate$/, /^storage\.get$/]
const REQ_ID = /^[A-Za-z0-9_-]{8,64}$/
const MAX_FRAME = 4 * 1024 * 1024
const MAX_BUFFERED = 8 * 1024 * 1024
const MAX_SKEW_MS = 5 * 60 * 1000
const HANDSHAKE_MS = 10000

function createControlChannel ({
  api,
  store,
  WebSocket,
  post,
  enabled = false,
  url,
  allowInsecureLocal = false,
  deviceInfo = () => ({}),
  maxInflight = 4,
  random = Math.random,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  log = () => {}
} = {}) {
  if (!api || !store) throw new TypeError('control channel requires api and store')
  const state = {
    status: enabled ? 'idle' : 'disabled',
    attempt: 0,
    lastError: null,
    connectedAt: null,
    url: url || null,
    killed: false
  }
  let ws = null
  let session = null
  let reconnectTimer = null
  let hsTimer = null
  let hbTimer = null
  let wantConnected = false
  let unsubEvents = null
  let dseq = 0
  let evtWindow = { t: 0, n: 0 }
  const inflight = new Map()
  const recent = new Map()
  const takeover = { on: false, by: null, since: null }

  const isKilled = () => state.killed || store.killed()
  const setError = (code) => { state.lastError = code ? String(code).slice(0, 60) : null }

  function sendFrame (frame) {
    if (!ws || ws.readyState !== 1) return false
    const data = JSON.stringify(frame)
    if (Buffer.byteLength(data) > (session ? session.maxFrameBytes : MAX_FRAME)) return false
    ws.send(data)
    return true
  }

  function audit (req, effect, rule, errorCode) {
    try {
      api.audit.record({
        deviceId: (deviceInfo().deviceId) || 'device',
        actor: { kind: REMOTE_ACTOR.kind, id: REMOTE_ACTOR.id },
        transport: REMOTE_ACTOR.transport,
        requestId: String(req.id || 'invalid').slice(0, 64),
        command: String(req.command || 'unknown').slice(0, 80),
        ...(req.browserId ? { browserId: String(req.browserId).slice(0, 40) } : {}),
        ...(req.tabId ? { tabId: String(req.tabId).slice(0, 40) } : {}),
        paramsDigest: req.params,
        decision: { effect, rule },
        outcome: { ok: false, errorCode }
      })
    } catch {}
  }

  function errResponse (id, code, message) {
    return { v: 1, requestId: id, ok: false, error: { code, message, retryable: false } }
  }

  function sendRes (id, response) {
    const safe = U.scrub(response)
    const frame = { t: 'res', v: 1, id, dseq: ++dseq, response: safe }
    if (!sendFrame(frame)) {
      const small = { t: 'res', v: 1, id, dseq, response: errResponse(id, 'RESULT_TOO_LARGE', 'Result exceeds the maximum frame size') }
      sendFrame(small)
    }
  }

  async function onCmd (f) {
    const id = f.id
    const req = { id, command: f.command, params: f.params, browserId: f.browserId, tabId: f.tabId }
    if (typeof id !== 'string' || !REQ_ID.test(id) || typeof f.command !== 'string') {
      audit(req, 'deny', 'invalid-envelope', 'INVALID_REQUEST')
      return sendFrame({ t: 'ack', v: 1, id: String(id).slice(0, 64), status: 'rejected', error: 'INVALID_REQUEST' })
    }
    if (recent.has(id)) {
      sendFrame({ t: 'ack', v: 1, id, status: 'duplicate' })
      const cached = recent.get(id)
      if (cached) sendRes(id, cached)
      return
    }
    if (inflight.has(id)) return sendFrame({ t: 'ack', v: 1, id, status: 'duplicate' })
    const deadline = Number.isFinite(f.deadline) ? f.deadline : now() + 30000
    if (deadline <= now()) {
      audit(req, 'deny', 'deadline', 'TIMEOUT')
      return sendFrame({ t: 'ack', v: 1, id, status: 'rejected', error: 'TIMEOUT' })
    }
    if (REMOTE_BLOCKED.some((re) => re.test(f.command))) {
      audit(req, 'deny', 'remote-blocked', 'POLICY_DENIED')
      sendFrame({ t: 'ack', v: 1, id, status: 'accepted' })
      const r = errResponse(id, 'POLICY_DENIED', 'This command cannot be run remotely')
      recent.set(id, r)
      return sendRes(id, r)
    }
    const role = f.role === 'operator' ? 'operator' : 'agent'
    if (takeover.on && role !== 'operator') {
      audit(req, 'deny', 'takeover', 'TAKEOVER')
      return sendFrame({ t: 'ack', v: 1, id, status: 'rejected', error: 'TAKEOVER' })
    }
    if (inflight.size >= maxInflight) {
      audit(req, 'deny', 'busy', 'BUSY')
      return sendFrame({ t: 'ack', v: 1, id, status: 'rejected', error: 'BUSY', retryAfterMs: 1000 })
    }
    inflight.set(id, role)
    sendFrame({ t: 'ack', v: 1, id, status: 'accepted' })
    const timeoutMs = Math.max(100, Math.min(120000, deadline - now()))
    let response
    try {
      response = await api.dispatcher.execute({
        v: 1,
        requestId: id,
        command: f.command,
        params: f.params && typeof f.params === 'object' && !Array.isArray(f.params) ? f.params : {},
        ...(f.browserId ? { browserId: f.browserId } : {}),
        ...(f.tabId ? { tabId: f.tabId } : {}),
        ...(f.leaseId ? { leaseId: f.leaseId } : {}),
        ...(f.taskId ? { taskId: f.taskId } : {}),
        timeoutMs
      }, REMOTE_ACTOR)
    } catch (e) {
      response = errResponse(id, 'INTERNAL', 'Internal error')
    }
    inflight.delete(id)
    recent.set(id, response)
    if (recent.size > 256) recent.delete(recent.keys().next().value)
    if (ws && ws.readyState === 1) sendRes(id, response)
  }

  function onCancel (f) {
    if (typeof f.id === 'string' && inflight.has(f.id)) {
      try { api.dispatcher.cancel(f.id, REMOTE_ACTOR) } catch {}
    }
  }

  function onTakeover (f) {
    const on = f.on === true
    takeover.on = on
    takeover.by = on ? String(f.by || 'operator').slice(0, 80) : null
    takeover.since = on ? now() : null
    if (on) {
      for (const [id, role] of inflight) {
        if (role !== 'operator') { try { api.dispatcher.cancel(id, REMOTE_ACTOR) } catch {} }
      }
    }
  }

  function startEvents () {
    unsubEvents = api.events.subscribe((ev) => {
      if (!session || !ws || ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) return
      const t = now()
      if (t - evtWindow.t >= 1000) evtWindow = { t, n: 0 }
      if (++evtWindow.n > 100) return
      sendFrame({ t: 'evt', v: 1, dseq: ++dseq, event: U.scrub(ev) })
    })
  }

  function cleanup () {
    timers.clearTimeout(hsTimer)
    timers.clearInterval(hbTimer)
    hsTimer = hbTimer = null
    if (unsubEvents) { try { unsubEvents() } catch {} unsubEvents = null }
    for (const id of inflight.keys()) { try { api.dispatcher.cancel(id, REMOTE_ACTOR) } catch {} }
    inflight.clear()
    session = null
    state.connectedAt = null
  }

  function scheduleReconnect (retryAfterMs) {
    if (!wantConnected || isKilled() || reconnectTimer) return
    const cap = Math.min(60000, 1000 * 2 ** Math.min(state.attempt, 6))
    const delay = Number.isFinite(retryAfterMs) ? retryAfterMs : Math.max(250, Math.floor(random() * cap))
    state.attempt++
    state.status = 'backoff'
    state.nextRetryMs = delay
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; open() }, delay)
  }

  function fail (code, { retry = true, retryAfterMs, permanent } = {}) {
    setError(code)
    const sock = ws
    ws = null
    if (sock) { try { sock.close() } catch {} }
    cleanup()
    if (permanent) {
      wantConnected = false
      state.status = 'revoked'
      return
    }
    state.status = 'idle'
    if (retry) scheduleReconnect(retryAfterMs)
  }

  function onFrame (raw, id, sock, handshake) {
    let f
    try {
      if (Buffer.byteLength(raw) > MAX_FRAME) return fail('FRAME_TOO_LARGE')
      f = JSON.parse(String(raw))
    } catch { return }
    if (!f || typeof f !== 'object' || f.v !== 1) return
    if (session) session.lastSeen = now()

    if (!session) {
      if (f.t === 'challenge' && !handshake.sent) {
        if (typeof f.challenge !== 'string' || f.challenge.length < 16 || f.challenge.length > 256) return fail('BAD_CHALLENGE')
        handshake.sent = true
        handshake.challenge = f.challenge
        handshake.nonce = crypto.randomBytes(16).toString('base64')
        const info = deviceInfo()
        sock.send(JSON.stringify({
          t: 'hello',
          v: 1,
          deviceId: id.deviceId,
          anubisVersion: info.anubisVersion || 'unknown',
          apiVersions: [1],
          capabilities: api.registry.list().map((c) => c.name || c),
          nonce: handshake.nonce,
          auth: { keyId: id.keyId, sig: U.sign(id.privateKey, U.helloMessage(id.deviceId, handshake.nonce, handshake.challenge)) }
        }))
        return
      }
      if (f.t === 'reject') {
        const revoked = f.code === 'DEVICE_REVOKED'
        return fail(String(f.code || 'REJECTED'), { permanent: revoked, retry: !revoked, retryAfterMs: Number.isFinite(f.retryAfterMs) ? Math.min(f.retryAfterMs, 3600000) : undefined })
      }
      if (f.t === 'welcome' && handshake.sent) {
        const okSig = typeof f.sessionId === 'string' && U.verify(id.serverPublicKey, U.welcomeMessage(f.sessionId, handshake.nonce, handshake.challenge), f.serverSig)
        if (!okSig) return fail('SERVER_AUTH_FAILED')
        if (!Number.isFinite(f.serverTime) || Math.abs(f.serverTime - now()) > MAX_SKEW_MS) return fail('CLOCK_SKEW')
        const heartbeatMs = Math.max(1000, Math.min(60000, Number(f.heartbeatMs) || 15000))
        session = {
          id: f.sessionId,
          serverKey: id.serverPublicKey,
          heartbeatMs,
          deadAfterMs: Math.max(heartbeatMs * 2, Math.min(180000, Number(f.deadAfterMs) || 45000)),
          maxFrameBytes: Math.min(MAX_FRAME, Number(f.maxFrameBytes) || MAX_FRAME),
          lastSseq: 0,
          lastSeen: now(),
          pingN: 0
        }
        timers.clearTimeout(hsTimer)
        state.status = 'connected'
        state.attempt = 0
        state.connectedAt = now()
        setError(null)
        hbTimer = timers.setInterval(() => {
          if (!session) return
          if (now() - session.lastSeen > session.deadAfterMs) return fail('HEARTBEAT_TIMEOUT')
          sendFrame({ t: 'ping', v: 1, n: ++session.pingN })
        }, session.heartbeatMs)
        startEvents()
      }
      return
    }

    switch (f.t) {
      case 'ping': return sendFrame({ t: 'pong', v: 1, n: f.n, load: { inflight: inflight.size } })
      case 'pong': return undefined
      case 'bye': {
        const revoked = f.code === 'revoked'
        return fail('BYE_' + String(f.code || '').slice(0, 20), { permanent: revoked, retryAfterMs: Number.isFinite(f.reconnectAfterMs) ? Math.min(f.reconnectAfterMs, 3600000) : undefined })
      }
      case 'cmd':
      case 'cancel':
      case 'takeover': {
        if (f.sid !== session.id || !U.verify(session.serverKey, U.frameForSig(f), f.sig)) {
          audit({ id: f.id, command: f.command }, 'deny', 'bad-signature', 'UNAUTHENTICATED')
          setError('BAD_SIGNATURE')
          return undefined
        }
        if (!Number.isInteger(f.sseq) || f.sseq <= session.lastSseq) return undefined
        session.lastSseq = f.sseq
        if (isKilled()) return undefined
        if (f.t === 'takeover') return onTakeover(f)
        return f.t === 'cmd' ? onCmd(f) : onCancel(f)
      }
      default: return undefined
    }
  }

  function open () {
    if (ws || isKilled() || !wantConnected) return
    const id = store.identity()
    if (!id) { state.status = 'unenrolled'; return }
    let target
    try { target = U.parseCcUrl(id.url || state.url, { allowInsecureLocal }) } catch (e) { setError(e.code); state.status = 'idle'; return }
    state.status = 'connecting'
    const sock = new WebSocket(target.href, { maxPayload: MAX_FRAME, handshakeTimeout: HANDSHAKE_MS, followRedirects: false })
    ws = sock
    const handshake = {}
    hsTimer = timers.setTimeout(() => { if (ws === sock && !session) fail('HANDSHAKE_TIMEOUT') }, HANDSHAKE_MS)
    sock.on('message', (data) => { if (ws === sock) onFrame(data, id, sock, handshake) })
    sock.on('error', () => { if (ws === sock) fail('CONNECT_ERROR') })
    sock.on('close', () => { if (ws === sock) fail('CLOSED') })
  }

  async function enroll ({ token, deviceName } = {}) {
    if (!enabled) throw U.ccError('DISABLED', 'Control Center channel is disabled')
    if (isKilled()) throw U.ccError('KILLED', 'Control Center channel is switched off')
    if (typeof token !== 'string' || token.length < 8 || token.length > 512) throw U.ccError('INVALID_REQUEST', 'enrollment token is required')
    const target = U.parseCcUrl(url, { allowInsecureLocal })
    const kp = U.generateKeyPair()
    const info = deviceInfo()
    const body = {
      enrollmentToken: token,
      ...(info.deviceId ? { deviceId: info.deviceId } : {}),
      publicKey: kp.publicKey,
      anubisVersion: info.anubisVersion || 'unknown',
      os: process.platform,
      deviceName: String(deviceName || info.deviceId || 'device').slice(0, 80)
    }
    let res
    try { res = await post(U.enrollUrl(target).href, body) } catch { throw U.ccError('ENROLL_FAILED', 'Enrollment request failed') }
    if (!res || typeof res.deviceId !== 'string' || typeof res.keyId !== 'string' || typeof res.serverPublicKey !== 'string' || !res.serverPublicKey) {
      throw U.ccError('ENROLL_FAILED', 'Enrollment was rejected or the reply is malformed')
    }
    store.saveIdentity({ deviceId: res.deviceId.slice(0, 80), keyId: res.keyId.slice(0, 80), publicKey: kp.publicKey, privateKey: kp.privateKey, serverPublicKey: res.serverPublicKey, url: target.href })
    state.url = target.href
    return { enrolled: true, deviceId: res.deviceId, keyId: res.keyId, serverKeyFingerprint: U.fingerprint(res.serverPublicKey) }
  }

  function connect () {
    if (!enabled) throw U.ccError('DISABLED', 'Control Center channel is disabled')
    if (isKilled()) throw U.ccError('KILLED', 'Control Center channel is switched off')
    if (!store.identity()) throw U.ccError('NOT_ENROLLED', 'Device is not enrolled')
    wantConnected = true
    state.attempt = 0
    open()
    return status()
  }

  function disconnect () {
    wantConnected = false
    timers.clearTimeout(reconnectTimer)
    reconnectTimer = null
    const sock = ws
    ws = null
    if (sock) { try { sock.send(JSON.stringify({ t: 'bye', v: 1, code: 'shutdown' })) } catch {} try { sock.close() } catch {} }
    cleanup()
    state.status = enabled ? 'idle' : 'disabled'
    return status()
  }

  function kill () {
    state.killed = true
    store.setKilled(true)
    disconnect()
    state.status = 'killed'
    return status()
  }

  function resume () {
    state.killed = false
    store.setKilled(false)
    state.status = enabled ? 'idle' : 'disabled'
    return status()
  }

  function forget () {
    disconnect()
    store.clear()
    takeover.on = false
    takeover.by = takeover.since = null
    state.killed = false
    state.status = enabled ? 'idle' : 'disabled'
    return status()
  }

  function status () {
    const id = store.identity()
    return {
      enabled,
      state: isKilled() ? 'killed' : state.status,
      url: (id && id.url) || state.url,
      enrolled: !!id,
      deviceId: id ? id.deviceId : null,
      keyId: id ? id.keyId : null,
      serverKeyFingerprint: id && id.serverPublicKey ? U.fingerprint(id.serverPublicKey) : null,
      keyProtected: store.isProtected(),
      killed: isKilled(),
      attempt: state.attempt,
      inflight: inflight.size,
      takeover: takeover.on,
      lastError: state.lastError,
      connectedAt: state.connectedAt ? new Date(state.connectedAt).toISOString() : null
    }
  }

  return { enroll, connect, disconnect, kill, resume, forget, status, dispose: disconnect, REMOTE_ACTOR }
}

function defaultPost (urlStr, body) {
  const u = new URL(urlStr)
  const mod = require(u.protocol === 'https:' ? 'node:https' : 'node:http')
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const r = mod.request(u, { method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let size = 0
      const chunks = []
      res.on('data', (c) => { size += c.length; if (size > 65536) { res.destroy(); reject(new Error('too large')) } else chunks.push(c) })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('status ' + res.statusCode))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
      })
    })
    r.on('timeout', () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    r.end(data)
  })
}

module.exports = { createControlChannel, defaultPost, REMOTE_ACTOR, REMOTE_BLOCKED }
