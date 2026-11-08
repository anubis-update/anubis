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
  // CalculateNativeWinOcclusion must be disabled: on Windows, Chromium marks a
  // window it believes is occluded as hidden and STOPS painting it, which stops
  // Page.startScreencast from ever emitting a frame (screencastVisibilityChanged
  // -> visible:false). The backgrounding flags keep the renderer painting even
  // when the window is not focused. Without these the engine streams nothing.
  '--disable-features=TranslateUI,CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
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

function buildLaunchArgs ({
  userDataDir, width, height, pipe = true, url, extraFlags = [],
  profileDirectory, headless, unsafeExtensionDebugging
} = {}) {
  const args = [
    pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    ...HARDENING_FLAGS
  ]
  if (profileDirectory) args.push('--profile-directory=' + profileDirectory)
  if (headless) args.push('--headless=new')
  if (unsafeExtensionDebugging) args.push('--enable-unsafe-extension-debugging')
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
      const listener = { cb, sessionId }
      listeners.get(method).push(listener)
      return () => {
        const entries = listeners.get(method)
        const index = entries.indexOf(listener)
        if (index >= 0) entries.splice(index, 1)
      }
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

// Bulky, regenerable sub-directories not worth copying from the real profile:
// skipping them keeps the managed copy small/fast while preserving the parts
// that carry identity (cookies, logins, preferences, Local State key).
const PROFILE_SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker', 'Crashpad',
  'Safe Browsing', 'BrowserMetrics', 'component_crx_cache', 'extensions_crx_cache',
  'optimization_guide_model_store', 'segmentation_platform', 'GraphiteDawnCache'
])

// Per-process singleton/lock artifacts that are held open by the running browser
// and must not be copied (copying them would both fail and confuse the clone).
const PROFILE_SKIP_FILES = /^(lockfile|Singleton(Lock|Cookie|Socket)|\.lock)$/i

// Copy a browser profile tree file-by-file, tolerating the per-file EBUSY/EPERM
// errors that occur when the user's browser is still running (strategy A clones
// a live profile). A single fs.cp would abort the whole copy on the first locked
// file, leaving an empty throwaway profile; this skips locked files and bulky
// caches and keeps going so cookies/logins survive. Concrete (Node fs only), not
// exercised by the launcher unit tests, but unit-tested directly.
async function copyProfileTolerant (src, dst) {
  let entries
  try {
    entries = await fs.promises.readdir(src, { withFileTypes: true })
  } catch {
    return
  }
  await fs.promises.mkdir(dst, { recursive: true }).catch(() => {})
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      if (PROFILE_SKIP_DIRS.has(entry.name)) continue
      await copyProfileTolerant(from, to)
    } else if (entry.isFile()) {
      if (PROFILE_SKIP_FILES.test(entry.name)) continue
      try { await fs.promises.copyFile(from, to) } catch {}
    }
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
  resolveHubUserDataDir,
  resolveLaunchOptions = () => ({}),
  copyFile,
  removeDir,
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
  const closing = new Map()

  function makeHandle (id, key, slot, reused) {
    return {
      id,
      browser: key,
      reused: !!reused,
      exePath: slot.exePath,
      userDataDir: slot.userDataDir,
      profileId: slot.profileId,
      profileDirectory: slot.profileDirectory,
      unsafeExtensionDebugging: slot.unsafeExtensionDebugging,
      child: slot.child,
      transport: slot.transport,
      client: slot.client,
      mode: slot.mode,
      onExit (cb) {
        slot.child.once('exit', cb)
        return () => slot.child.removeListener('exit', cb)
      },
      close () {
        if (slot.refs > 0) slot.refs--
        if (slot.refs > 0) return
        slot.alive = false
        if (shared.get(key) === slot) shared.delete(key)
        if (slot.child && slot.child.exitCode === null && slot.child.signalCode === null) {
          const stopped = new Promise(resolve => slot.child.once('exit', resolve))
          closing.set(key, stopped)
          stopped.then(() => { if (closing.get(key) === stopped) closing.delete(key) })
        }
        try { if (slot.client && slot.client.close) slot.client.close() } catch {}
        try { if (slot.transport && slot.transport.close) slot.transport.close() } catch {}
        try { if (slot.child && slot.child.kill) slot.child.kill() } catch {}
      }
    }
  }

  async function launcher ({ id, url, width, height, browser = 'chrome' } = {}) {
    const key = normalizeBrowser(browser)
    if (closing.has(key)) {
      let timer
      try {
        await Promise.race([
          closing.get(key),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(codedError('BROWSER_ALREADY_RUNNING', 'The previous browser is still shutting down; retry shortly')), 10000)
          })
        ])
      } finally { clearTimeout(timer) }
    }
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
    const { profileId, profileDirectory, unsafeExtensionDebugging = false } = await resolveLaunchOptions(key)
    if (profileDirectory !== undefined && !/^[A-Za-z0-9 _-]{1,64}$/.test(profileDirectory)) {
      throw codedError('PROFILE_NOT_FOUND', 'Invalid selected profile directory')
    }
    const userDataDir = resolveUserDataDir(browser, { env })
    const exists = typeof fsExists === 'function' ? fsExists : fs.existsSync
    // Re-seeding overwrites browser-owned extension state on every restart.
    const seeded = await exists(path.join(userDataDir, profileDirectory || 'Default', 'Preferences'))
    if (typeof copyProfile === 'function' && !seeded) {
      const source = resolveSourceProfile(browser, { env })
      if (source) {
        // Fail fast if the user profile to copy does not exist (e.g. a SYSTEM
        // session-0 runtime whose systemprofile has no browser data): spawning
        // anyway would stream an empty throwaway profile and leak the process.
        // In a user-context runtime the real profile exists, so this never trips.
        if (!await exists(source)) {
          throw codedError('PROFILE_SOURCE_MISSING', `No ${key} profile was found to copy; open the browser from your user session`)
        }
        try {
          if (await exists(path.join(userDataDir, 'Local State'))) {
            const directory = profileDirectory || 'Default'
            await copyProfile(path.join(source, directory), path.join(userDataDir, directory))
          } else {
            await copyProfile(source, userDataDir)
          }
        } catch (error) {
          if (log && typeof log.warn === 'function') log.warn('CDP profile copy failed:', error && error.message)
        }
      }
    }
    let child = null
    let transport = null
    let mode = null
    if (preferPipe && typeof connectPipe === 'function') {
      child = spawn(exePath, buildLaunchArgs({ userDataDir, width, height, pipe: true, url, profileDirectory, unsafeExtensionDebugging }), {
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
      child = spawn(exePath, buildLaunchArgs({ userDataDir, width, height, pipe: false, url, profileDirectory, unsafeExtensionDebugging }), { stdio: 'ignore' })
      const endpoint = await readDevToolsEndpoint(userDataDir, child)
      transport = await connectPort(endpoint)
      mode = 'port'
    }
    const slot = {
      key,
      exePath,
      userDataDir,
      profileId,
      profileDirectory,
      unsafeExtensionDebugging,
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
  async function cdpClient (handle, { targetId: selectedTargetId } = {}) {
    if (!handle || !handle.transport) throw new Error('CDP launch handle has no transport')
    const client = handle.client || createCdpClient(handle.transport)
    await client.send('Target.setDiscoverTargets', { discover: true })
    let targetId = selectedTargetId
    if (!targetId && handle.reused) {
      // The browser is already alive (re-open/refresh). Give this session its
      // own page target (a new tab in the same window/process) so its screencast
      // is independent of any other session's page.
      const created = await client.send('Target.createTarget', { url: 'about:blank' })
      targetId = created && created.targetId
    } else if (!targetId) {
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
    const subscriptions = []
    return {
      targetId,
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
      on: (method, cb) => {
        const off = client.on(method, cb, sessionId)
        if (typeof off === 'function') subscriptions.push(off)
        return off
      },
      // Detach just this session; the shared transport/process is torn down by
      // the handle's reference-counted close().
      close: () => {
        for (const off of subscriptions.splice(0)) off()
        if (sessionId !== undefined) client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      }
    }
  }

  // Browser-level launch for the Browser Hub driver (browser -> N tabs). Unlike
  // `launcher` it is never shared/ref-counted, does NOT attach to a page, and
  // supports dedicated / managed-copy / ephemeral profiles plus a specific
  // profile directory. Existing `launcher`/`cdpClient` behaviour is untouched.
  async function launchBrowser ({
    id,
    browser = 'chrome',
    profileMode = 'dedicated',
    profileId,
    profileDirectory,
    url,
    width,
    height,
    headless,
    extraFlags = [],
    unsafeExtensionDebugging = false
  } = {}) {
    const key = normalizeBrowser(browser)
    const exePath = detectPath(browser, { env, fsExists })
    if (!exePath) throw codedError('BROWSER_NOT_FOUND', `No ${key} installation was found`)
    if (!['dedicated', 'managed-copy', 'ephemeral'].includes(profileMode)) {
      throw codedError('INVALID_REQUEST', 'Unknown profileMode')
    }
    const hubRoot = typeof resolveHubUserDataDir === 'function'
      ? null
      : path.join(path.dirname(resolveUserDataDir(browser, { env })), 'hub', key)
    const safeName = String(profileId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default'
    let userDataDir
    let ephemeral = false
    if (profileMode === 'ephemeral') {
      ephemeral = true
      userDataDir = typeof resolveHubUserDataDir === 'function'
        ? resolveHubUserDataDir(browser, { profileMode, profileId: 'eph_' + String(id) })
        : path.join(hubRoot, 'eph_' + String(id).replace(/[^A-Za-z0-9_-]/g, '_'))
    } else {
      userDataDir = typeof resolveHubUserDataDir === 'function'
        ? resolveHubUserDataDir(browser, { profileMode, profileId: safeName })
        : path.join(hubRoot, profileMode === 'managed-copy' ? 'copy_' + safeName : safeName)
    }
    const warnings = []
    if (profileMode === 'managed-copy') {
      const source = resolveSourceProfile(browser, { env })
      const dir = profileDirectory || 'Default'
      const exists = source && (typeof fsExists === 'function' ? await fsExists(path.join(source, dir)) : fs.existsSync(path.join(source, dir)))
      if (!exists) throw codedError('PROFILE_NOT_FOUND', `No ${key} profile was found to copy`)
      if (typeof isBrowserRunning === 'function' && await isBrowserRunning(browser)) {
        warnings.push(`A ${key} window is running; locked profile files were skipped`)
      }
      if (typeof copyProfile === 'function') {
        await copyProfile(path.join(source, dir), path.join(userDataDir, dir))
        if (typeof copyFile === 'function') {
          try { await copyFile(path.join(source, 'Local State'), path.join(userDataDir, 'Local State')) } catch {}
        }
      }
      warnings.push('Copied profile may not carry sessions or saved passwords (App-Bound Encryption)')
    }
    const buildArgs = (pipe) => buildLaunchArgs({
      userDataDir,
      width,
      height,
      pipe,
      url,
      extraFlags,
      profileDirectory: profileMode === 'managed-copy' ? (profileDirectory || 'Default') : undefined,
      headless,
      unsafeExtensionDebugging: !!unsafeExtensionDebugging && profileMode !== 'managed-copy'
    })
    let child = null
    let transport = null
    let mode = null
    if (preferPipe && typeof connectPipe === 'function') {
      child = spawn(exePath, buildArgs(true), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
      try {
        transport = await connectPipe(child)
        mode = 'pipe'
      } catch (error) {
        if (log && typeof log.warn === 'function') log.warn('CDP pipe connect failed, using port:', error && error.message)
        try { if (child && child.kill) child.kill() } catch {}
        child = null
      }
    }
    if (!transport) {
      child = spawn(exePath, buildArgs(false), { stdio: 'ignore' })
      const endpoint = await readDevToolsEndpoint(userDataDir, child)
      transport = await connectPort(endpoint)
      mode = 'port'
    }
    const client = createCdpClient(transport)
    let closed = false
    const exitCallbacks = []
    const fireExit = () => { for (const cb of exitCallbacks.splice(0)) { try { cb() } catch {} } }
    if (child && typeof child.once === 'function') child.once('exit', fireExit)
    if (transport && typeof transport.on === 'function') transport.on('close', fireExit)
    return {
      id,
      browser: key,
      exePath,
      userDataDir,
      profileDirectory: profileDirectory || 'Default',
      profileMode,
      warnings,
      child,
      transport,
      client,
      mode,
      onExit (cb) { exitCallbacks.push(cb) },
      close () {
        if (closed) return
        closed = true
        try { client.close() } catch {}
        try { if (child && child.kill) child.kill() } catch {}
        if (ephemeral && typeof removeDir === 'function') {
          try { Promise.resolve(removeDir(userDataDir)).catch(() => {}) } catch {}
        }
      }
    }
  }

  return { launcher, cdpClient, launchBrowser }
}

module.exports = {
  createCdpLaunch,
  createCdpClient,
  detectBrowserPath,
  buildLaunchArgs,
  readDevToolsPort,
  createPipeTransport,
  createWsTransport,
  copyProfileTolerant,
  HARDENING_FLAGS
}
