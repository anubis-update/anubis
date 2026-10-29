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
// as a CDP client over a SINGLE message consumer (never register two handlers on
// one transport). It is session-aware for CDP "flatten" mode:
//   send(method, params, sessionId) routes a command to a target session when a
//     sessionId is given (top-level field); browser-level calls omit it.
//   on(method, cb, sessionId) binds a listener to a session.
// An incoming event is delivered to a listener when it carries the listener's
// sessionId OR no sessionId at all (browser-level events such as
// Target.targetInfoChanged reach the single page facade too). Response
// correlation is by global id and is unchanged. Engine-agnostic and fully
// testable with a fake transport.
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
      if (cbs) {
        for (const { cb, sessionId } of cbs) {
          if (msg.sessionId === sessionId || msg.sessionId === undefined) cb(msg.params || {})
        }
      }
    }
  })
  transport.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP transport closed'))
    pending.clear()
  })
  return {
    send (method, params, sessionId) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          const message = { id, method, params: params || {} }
          if (sessionId !== undefined) message.sessionId = sessionId
          transport.send(JSON.stringify(message))
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    on (method, cb, sessionId) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push({ cb, sessionId })
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

  // One managed browser process per browser type, reference-counted. Reusing a
  // live instance on re-open/refresh avoids spawning a second process that the
  // Chromium user-data-dir singleton bounces into a stray visible window; the
  // real teardown only runs when the last session for that browser closes.
  const shared = new Map()

  function makeHandle (id, key, slot, reused) {
    return {
      id,
      browser: key,
      reused: !!reused,
      exePath: slot.exePath,
      userDataDir: slot.userDataDir,
      child: slot.child,
      transport: slot.transport,
      client: slot.client,
      mode: slot.mode,
      close () {
        if (slot.refs > 0) slot.refs--
        if (slot.refs > 0) return
        slot.alive = false
        if (shared.get(key) === slot) shared.delete(key)
        try { if (slot.client && slot.client.close) slot.client.close() } catch {}
        try { if (slot.transport && slot.transport.close) slot.transport.close() } catch {}
        try { if (slot.child && slot.child.kill) slot.child.kill() } catch {}
      }
    }
  }

  async function launcher ({ id, url, width, height, browser = 'chrome' } = {}) {
    const key = normalizeBrowser(browser)
    const exePath = detectPath(browser, { env, fsExists })
    if (!exePath) throw codedError('BROWSER_NOT_FOUND', `No ${key} installation was found`)
    const live = shared.get(key)
    if (live && live.alive) {
      live.refs++
      return makeHandle(id, key, live, true)
    }
    if (typeof isBrowserRunning === 'function' && await isBrowserRunning(browser)) {
      throw codedError('BROWSER_ALREADY_RUNNING', `Close your running ${key} window and try again`)
    }
    const userDataDir = resolveUserDataDir(browser, { env })
    if (typeof copyProfile === 'function') {
      const source = resolveSourceProfile(browser, { env })
      if (source) {
        // Fail fast if the user profile to copy does not exist (e.g. a SYSTEM
        // session-0 runtime whose systemprofile has no browser data): spawning
        // anyway would stream an empty throwaway profile and leak the process.
        // In a user-context runtime the real profile exists, so this never trips.
        const exists = typeof fsExists === 'function' ? await fsExists(source) : fs.existsSync(source)
        if (!exists) {
          throw codedError('PROFILE_SOURCE_MISSING', `No ${key} profile was found to copy; open the browser from your user session`)
        }
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
    const slot = {
      key,
      exePath,
      userDataDir,
      child,
      transport,
      // Create the CDP client ONCE per transport so a single message handler is
      // registered even when several sessions share the browser.
      client: createCdpClient(transport),
      mode,
      refs: 1,
      alive: true
    }
    if (child && typeof child.once === 'function') {
      child.once('exit', () => { slot.alive = false; if (shared.get(key) === slot) shared.delete(key) })
    }
    shared.set(key, slot)
    return makeHandle(id, key, slot, false)
  }

  // Attach to a page target and return a session-bound facade with the SAME
  // { send, on, close } shape createCdpBrowser expects. Page/Input/Emulation/
  // Network commands only resolve against a PAGE target session: on the raw
  // browser-level endpoint they fail with "wasn't found". The launcher normally
  // already opened a page target at the url (CLI arg), so we attach to it; if
  // none exists we create one. Note: the CDP target `sessionId` lives at the
  // message top level and is distinct from Page.screencastFrameAck's
  // `params.sessionId` (the screencast id), which stays in params.
  async function cdpClient (handle) {
    if (!handle || !handle.transport) throw new Error('CDP launch handle has no transport')
    const client = handle.client || createCdpClient(handle.transport)
    await client.send('Target.setDiscoverTargets', { discover: true })
    let targetId
    if (handle.reused) {
      // The browser is already alive (re-open/refresh). Give this session its
      // own page target (a new tab in the same window/process) so its screencast
      // is independent of any other session's page.
      const created = await client.send('Target.createTarget', { url: 'about:blank' })
      targetId = created && created.targetId
    } else {
      const info = await client.send('Target.getTargets')
      const targets = (info && Array.isArray(info.targetInfos)) ? info.targetInfos : []
      const page = targets.find((t) => t && t.type === 'page')
      targetId = page && page.targetId
      if (!targetId) {
        const created = await client.send('Target.createTarget', { url: 'about:blank' })
        targetId = created && created.targetId
      }
    }
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached && attached.sessionId
    // Raise the page to the foreground so Page.startScreencast does not fail with
    // "Not attached to an active page" when the just-launched window is not yet
    // the focused/active target. Target.activateTarget (browser-level) is the
    // reliable activation; Page.bringToFront backs it up.
    const activate = async () => {
      if (targetId !== undefined) await client.send('Target.activateTarget', { targetId }).catch(() => {})
      await client.send('Page.bringToFront', {}, sessionId).catch(() => {})
    }
    await activate()
    const rawSend = (method, params) => client.send(method, params, sessionId)
    return {
      // Page.startScreencast can still intermittently report the page as not
      // active right after launch; re-activate and retry a few times so the
      // stream reliably starts. The engine (cdp-browser.js) stays unchanged.
      send: async (method, params) => {
        if (method !== 'Page.startScreencast') return rawSend(method, params)
        let lastError
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            return await rawSend(method, params)
          } catch (error) {
            lastError = error
            if (!/not attached to an active page/i.test(error && error.message)) throw error
            await activate()
            await new Promise((resolve) => setTimeout(resolve, 150))
          }
        }
        throw lastError
      },
      on: (method, cb) => client.on(method, cb, sessionId),
      // Detach just this session; the shared transport/process is torn down by
      // the handle's reference-counted close().
      close: () => { if (sessionId !== undefined) client.send('Target.detachFromTarget', { sessionId }).catch(() => {}) }
    }
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
