/**
 * Real launcher + CDP client factory for the Chrome/Edge (`cdp-browser.js`)
 * engine — strategy A: drive the user's locally installed browser with a copy
 * of their own profile over the Chrome DevTools Protocol.
 *
 * Nothing is launched at import time and EVERY OS/process dependency is injected
 * (a `spawn` fn, fs helpers, the pipe/port transport connectors, an
 * already-running probe), so the whole flow is unit-testable with fakes and has
 * no hard dependency on a real browser. `createCdpLaunch()` returns the exact
 * `{ launcher, cdpClient }` pair that `createCdpBrowser` consumes.
 *
 * Launch flow:
 *   detect chrome.exe / msedge.exe -> refuse if an instance is already running
 *   -> copy the user's profile into a managed (non-default) user-data-dir ->
 *   spawn with `--remote-debugging-pipe` (preferred) or, on fallback,
 *   `--remote-debugging-port=0` + read DevToolsActivePort -> wrap the transport
 *   in a CDP client with request/response correlation and event subscription.
 *
 * NOTE: running this in the logged-on user's session (so it can reach the user's
 * real profile) is NOT solved here — that is the user-context runtime hosting
 * work proven later on canary. This module only provides the injectable,
 * unit-tested launcher/client slice.
 */

const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const HARDENING_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-features=TranslateUI',
  '--disable-breakpad',
  '--disable-domain-reliability',
  '--disable-component-update'
]

const BROWSER_CANDIDATES = {
  chrome: (env) => [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ],
  edge: (env) => [
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ]
}

const DEFAULT_SOURCE_PROFILE = {
  chrome: (env) => path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\User Data'),
  edge: (env) => path.join(env.LOCALAPPDATA || '', 'Microsoft\\Edge\\User Data')
}

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeBrowser (browser) {
  return browser === 'edge' ? 'edge' : 'chrome'
}

// Return the first installed browser executable among the well-known Windows
// locations, or null. `fsExists` is injected so tests never touch the disk.
function detectBrowserPath (browser, { env = process.env, fsExists } = {}) {
  const exists = typeof fsExists === 'function' ? fsExists : (p) => fs.existsSync(p)
  const build = BROWSER_CANDIDATES[normalizeBrowser(browser)]
  for (const candidate of build(env)) {
    if (candidate && exists(candidate)) return candidate
  }
  return null
}

function buildLaunchArgs ({ userDataDir, width, height, pipe = true, url, extraFlags = [] } = {}) {
  const args = [
    pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    ...HARDENING_FLAGS
  ]
  const w = Math.floor(Number(width))
  const h = Math.floor(Number(height))
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
    args.push(`--window-size=${w},${h}`)
  }
  for (const flag of extraFlags) args.push(flag)
  if (typeof url === 'string' && url) args.push(url)
  return args
}

// Wrap a low-level transport ({ send(str), on('message'|'close', cb), close() })
// as a CDP client: send(method, params) correlates a response by id, on(method)
// subscribes to protocol events. This is engine-agnostic and fully testable
// with a fake transport.
function createCdpClient (transport) {
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  transport.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'))
      else resolve(msg.result || {})
      return
    }
    if (typeof msg.method === 'string') {
      const cbs = listeners.get(msg.method)
      if (cbs) for (const cb of cbs) cb(msg.params || {})
    }
  })
  transport.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP transport closed'))
    pending.clear()
  })
  return {
    send (method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          transport.send(JSON.stringify({ id, method, params: params || {} }))
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    on (method, cb) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(cb)
    },
    close () { try { transport.close() } catch {} }
  }
}

// Default real transports (plain Node, no native code). They are not exercised
// by unit tests — they require a real browser — but are injectable and kept
// minimal so the live path on canary has a concrete implementation.
function createPipeTransport (child) {
  const emitter = new EventEmitter()
  const writable = child.stdio && child.stdio[3]
  const readable = child.stdio && child.stdio[4]
  if (!writable || !readable) throw new Error('remote-debugging-pipe fds are unavailable')
  let buffer = Buffer.alloc(0)
  readable.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    let index
    while ((index = buffer.indexOf(0)) !== -1) {
      emitter.emit('message', buffer.slice(0, index).toString('utf8'))
      buffer = buffer.slice(index + 1)
    }
  })
  readable.on('close', () => emitter.emit('close'))
  readable.on('error', () => emitter.emit('close'))
  return {
    on: (event, cb) => emitter.on(event, cb),
    send: (str) => { writable.write(str); writable.write('\0') },
    close: () => { try { writable.end() } catch {} }
  }
}

function createWsTransport (ws) {
  const emitter = new EventEmitter()
  ws.on('message', (data) => emitter.emit('message', data.toString()))
  ws.on('close', () => emitter.emit('close'))
  ws.on('error', () => emitter.emit('close'))
  return {
    on: (event, cb) => emitter.on(event, cb),
    send: (str) => ws.send(str),
    close: () => { try { ws.close() } catch {} }
  }
}

// Read the ephemeral debugging port Chromium writes to DevToolsActivePort in the
// user-data-dir after a `--remote-debugging-port=0` launch.
function readDevToolsPort (userDataDir, { fsReadFile } = {}) {
  const read = typeof fsReadFile === 'function'
    ? fsReadFile
    : (p) => fs.readFileSync(p, 'utf8')
  const raw = String(read(path.join(userDataDir, 'DevToolsActivePort')) || '')
  const port = parseInt(raw.split('\n')[0], 10)
  if (!Number.isFinite(port) || port <= 0) throw new Error('DevToolsActivePort was not written')
  return port
}

function createCdpLaunch ({
  spawn,
  fsExists,
  copyProfile,
  detectPath = detectBrowserPath,
  connectPipe,
  connectPort,
  readDevToolsEndpoint,
  isBrowserRunning,
  resolveUserDataDir,
  resolveSourceProfile = (browser, { env = process.env } = {}) => DEFAULT_SOURCE_PROFILE[normalizeBrowser(browser)](env),
  env = process.env,
  preferPipe = true,
  log = console
} = {}) {
  if (typeof spawn !== 'function') throw new TypeError('cdp-launch requires a spawn fn')
  if (typeof resolveUserDataDir !== 'function') throw new TypeError('cdp-launch requires resolveUserDataDir')

  async function launcher ({ id, url, width, height, browser = 'chrome' } = {}) {
    const exePath = detectPath(browser, { env, fsExists })
    if (!exePath) throw codedError('BROWSER_NOT_FOUND', `No ${normalizeBrowser(browser)} installation was found`)
    if (typeof isBrowserRunning === 'function' && await isBrowserRunning(browser)) {
      throw codedError('BROWSER_ALREADY_RUNNING', `Close your running ${normalizeBrowser(browser)} window and try again`)
    }
    const userDataDir = resolveUserDataDir(browser, { env })
    if (typeof copyProfile === 'function') {
      const source = resolveSourceProfile(browser, { env })
      if (source) {
        try {
          await copyProfile(source, userDataDir)
        } catch (error) {
          if (log && typeof log.warn === 'function') log.warn('CDP profile copy failed:', error && error.message)
        }
      }
    }
    let child = null
    let transport = null
    let mode = null
    if (preferPipe && typeof connectPipe === 'function') {
      child = spawn(exePath, buildLaunchArgs({ userDataDir, width, height, pipe: true, url }), {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
      })
      try {
        transport = await connectPipe(child)
        mode = 'pipe'
      } catch (error) {
        if (log && typeof log.warn === 'function') log.warn('CDP pipe connect failed, using port:', error && error.message)
        try { if (child && child.kill) child.kill() } catch {}
        child = null
        transport = null
      }
    }
    if (!transport) {
      child = spawn(exePath, buildLaunchArgs({ userDataDir, width, height, pipe: false, url }), { stdio: 'ignore' })
      const endpoint = await readDevToolsEndpoint(userDataDir, child)
      transport = await connectPort(endpoint)
      mode = 'port'
    }
    return {
      id,
      browser: normalizeBrowser(browser),
      exePath,
      userDataDir,
      child,
      transport,
      mode,
      close () {
        try { if (transport && transport.close) transport.close() } catch {}
        try { if (child && child.kill) child.kill() } catch {}
      }
    }
  }

  async function cdpClient (handle) {
    if (!handle || !handle.transport) throw new Error('CDP launch handle has no transport')
    return createCdpClient(handle.transport)
  }

  return { launcher, cdpClient }
}

module.exports = {
  createCdpLaunch,
  createCdpClient,
  detectBrowserPath,
  buildLaunchArgs,
  readDevToolsPort,
  createPipeTransport,
  createWsTransport,
  HARDENING_FLAGS
}
