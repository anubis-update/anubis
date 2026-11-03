/**
 * Local /v1 REST + WS/SSE adapter for the Browser API (SPEC-v1 §5).
 * Loopback only, bearer token, Host/Origin checks, no CORS. OFF unless
 * explicitly started by the caller (config flag in ipc wiring).
 */

const http = require('node:http')
const crypto = require('node:crypto')
const { httpStatusFor } = require('./errors')

const MAX_BODY = 1024 * 1024

function hashToken (t) {
  return crypto.createHash('sha256').update(String(t)).digest()
}

function createTokenStore ({ now = () => Date.now() } = {}) {
  const entries = []
  return {
    issue (role = 'agent', ttlMs = 24 * 3600 * 1000) {
      const token = 'abt_' + crypto.randomBytes(24).toString('hex')
      entries.push({ hash: hashToken(token), role, expiresAt: now() + ttlMs, id: 'tok_' + crypto.randomBytes(4).toString('hex') })
      return token
    },
    verify (token) {
      if (!token) return null
      const h = hashToken(token)
      for (const e of entries) {
        if (crypto.timingSafeEqual(e.hash, h) && e.expiresAt > now()) return { id: e.id, role: e.role, kind: e.role }
      }
      return null
    },
    revokeAll () { entries.length = 0 }
  }
}

function createV1Server ({
  api,
  tokens,
  allowedOrigins = [],
  WebSocketServer,
  host = '127.0.0.1',
  port = 0,
  now = () => Date.now()
}) {
  let server
  let wss
  let boundPort = 0
  const sseClients = new Set()
  const wsClients = new Set()
  let unsubscribe

  function hostOk (h) {
    if (!h) return false
    return h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}` || h === `[::1]:${boundPort}`
  }

  function send (res, status, body, headers = {}) {
    const data = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data), ...headers })
    res.end(data)
  }

  function errBody (code, message) {
    return { v: 1, ok: false, error: { code, message, retryable: false } }
  }

  function guard (req) {
    if (!hostOk(req.headers.host)) return { status: 403, code: 'FORBIDDEN', message: 'Bad Host header' }
    const origin = req.headers.origin
    if (origin !== undefined && !allowedOrigins.includes(origin)) return { status: 403, code: 'FORBIDDEN', message: 'Origin not allowed' }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    const actor = tokens.verify(m && m[1])
    if (!actor) return { status: 401, code: 'UNAUTHENTICATED', message: 'Missing or invalid token' }
    return { actor }
  }

  function readBody (req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '')
      if (!/^application\/json(\s*;.*)?$/i.test(ct)) {
        const e = new Error('Content-Type must be application/json')
        e.status = 415
        return reject(e)
      }
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          const e = new Error('Body too large')
          e.status = 413
          reject(e)
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch {
          const e = new Error('Invalid JSON')
          e.status = 400
          reject(e)
        }
      })
      req.on('error', reject)
    })
  }

  function openSse (req, res, query) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const write = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`)
    const since = Number(query.get('since') || req.headers['last-event-id'] || 0) || 0
    api.events.since(since).forEach(write)
    const off = api.events.subscribe(write)
    const client = { close: () => { off(); res.end() } }
    sseClients.add(client)
    req.on('close', () => { off(); sseClients.delete(client) })
  }

  async function handle (req, res) {
    let url
    try { url = new URL(req.url, 'http://x') } catch { return send(res, 400, errBody('INVALID_REQUEST', 'Bad URL')) }
    const g = guard(req)
    if (!g.actor) return send(res, g.status, errBody(g.code, g.message))
    const actor = g.actor
    const p = url.pathname
    try {
      if (req.method === 'GET' && p === '/v1/capabilities') {
        const r = await api.dispatcher.execute({ v: 1, requestId: 'cap_' + crypto.randomBytes(6).toString('hex'), command: 'api.capabilities', params: {} }, actor)
        return send(res, r.ok ? 200 : httpStatusFor(r.error.code), r)
      }
      if (req.method === 'GET' && p === '/v1/events') return openSse(req, res, url.searchParams)
      if (req.method === 'GET' && p === '/v1/audit') {
        if (actor.role !== 'admin') return send(res, 403, errBody('FORBIDDEN', 'Admin only'))
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000)
        return send(res, 200, { v: 1, ok: true, result: { records: api.audit.query({ limit }) } })
      }
      if (req.method === 'POST' && p === '/v1/commands') {
        const body = await readBody(req)
        const r = await api.dispatcher.execute(body, actor)
        return send(res, r.ok ? 200 : httpStatusFor(r.error.code), r)
      }
      let m = /^\/v1\/commands\/([a-z][a-z0-9.]*)$/.exec(p)
      if (req.method === 'POST' && m) {
        const body = await readBody(req)
        const r = await api.dispatcher.execute({ v: 1, ...body, command: m[1] }, actor)
        return send(res, r.ok ? 200 : httpStatusFor(r.error.code), r)
      }
      m = /^\/v1\/requests\/([A-Za-z0-9_-]{8,64})$/.exec(p)
      if (req.method === 'DELETE' && m) {
        const ok = api.dispatcher.cancel(m[1], actor)
        return send(res, ok ? 200 : 404, ok ? { v: 1, ok: true, result: { cancelled: true } } : errBody('INVALID_REQUEST', 'No such running request'))
      }
      m = /^\/v1\/confirmations\/([A-Za-z0-9_-]+)$/.exec(p)
      if (req.method === 'POST' && m) {
        const local = req.headers['x-anubis-local-token']
        const expected = api.confirmations.localToken()
        const a = hashToken(local || '')
        const b = hashToken(expected || '\u0000none')
        if (!local || !crypto.timingSafeEqual(a, b)) return send(res, 403, errBody('FORBIDDEN', 'Confirmations are decided in the local UI only'))
        const body = await readBody(req)
        const r = api.confirmations.decide(m[1], body.approve === true, local)
        return send(res, 200, { v: 1, ok: true, result: r })
      }
      return send(res, 404, errBody('INVALID_REQUEST', 'Not found'))
    } catch (e) {
      const status = e.status || (e.code && httpStatusFor(e.code)) || 500
      return send(res, status, errBody(e.status === 400 ? 'INVALID_REQUEST' : e.status ? 'INVALID_REQUEST' : (e.code && status !== 500 ? e.code : 'INTERNAL'), e.status ? e.message : 'Request failed'))
    }
  }

  function onUpgrade (req, socket, head) {
    const url = new URL(req.url, 'http://x')
    const g = url.pathname === '/v1/events' ? guard(req) : { status: 404 }
    if (!g.actor) {
      socket.write(`HTTP/1.1 ${g.status} Error\r\nConnection: close\r\n\r\n`)
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsClients.add(ws)
      const since = Number(url.searchParams.get('since') || 0) || 0
      const out = (ev) => { if (ws.readyState === 1) ws.send(JSON.stringify(ev)) }
      api.events.since(since).forEach(out)
      const off = api.events.subscribe(out)
      ws.on('close', () => { off(); wsClients.delete(ws) })
    })
  }

  async function start () {
    server = http.createServer((req, res) => { handle(req, res) })
    if (WebSocketServer) {
      wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
      server.on('upgrade', onUpgrade)
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolve)
    })
    boundPort = server.address().port
    return { host, port: boundPort, startedAt: now() }
  }

  async function stop () {
    if (unsubscribe) unsubscribe()
    sseClients.forEach((c) => c.close())
    wsClients.forEach((w) => w.terminate())
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections && server.closeAllConnections() })
    server = null
  }

  return { start, stop, port: () => boundPort }
}

module.exports = { createV1Server, createTokenStore, MAX_BODY }
