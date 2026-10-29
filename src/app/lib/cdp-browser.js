/**
 * CDP browser host — the Chrome DevTools Protocol engine counterpart to
 * `./rbi-browser.js`.
 *
 * Where the RBI engine runs a hardened offscreen Electron `BrowserWindow` and
 * paints via the native `paint`/`sendInputEvent` path, this engine drives the
 * user's REAL local Chrome/Edge (their own profile) over CDP: frames arrive as
 * `Page.screencastFrame` events and semantic input is replayed with the
 * `Input.*` domain. It exposes the SAME public interface and callback contract
 * as `createRbiBrowser` (open/input/resize/nav/close/exportCookies/
 * importCookies/disposeAll/count, with onFrame(id, Buffer) and
 * onEvent(id, {t,...})), so a bridge can swap engines by an `engine` field with
 * zero client changes.
 *
 * It is fully unit-testable and has NO hard Electron/Chrome dependency: the
 * module spawns nothing at import time. Two dependencies are injected —
 *   (1) `launcher()`  -> resolves a launch handle (in real use it spawns
 *        chrome/edge with --remote-debugging-pipe / --remote-debugging-port=0
 *        + --user-data-dir),
 *   (2) `cdpClient(handle)` -> returns { send(method, params) => Promise,
 *        on(method, cb) } to talk to that browser.
 * Tests pass fakes for both.
 */

const DEFAULT_FRAME_QUALITY = 60
const DEFAULT_MAX_SESSIONS = 8
const MAX_DIMENSION = 4096

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'
])

function isHttpUrl (value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function clampDimension (value, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_DIMENSION)
}

function mouseButton (button) {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

// client bitmask: alt=1, ctrl=2, meta=4, shift=8 — CDP uses the identical
// bitmask for Input.dispatch{Mouse,Key}Event modifiers, so it passes through.
function cdpModifiers (mask) {
  let out = 0
  if (mask & 1) out |= 1
  if (mask & 2) out |= 2
  if (mask & 4) out |= 4
  if (mask & 8) out |= 8
  return out
}

function keyFor (key) {
  if (typeof key !== 'string' || key.length === 0) return undefined
  if (key.length === 1) return key
  if (SPECIAL_KEYS.has(key)) return key
  return undefined
}

// A valid override UA is a non-empty single-line string of sane length. Line
// breaks are rejected so a crafted value cannot smuggle extra request headers.
function isValidUserAgent (value) {
  return typeof value === 'string' &&
    value.length > 0 && value.length <= 1024 &&
    !/[\r\n]/.test(value)
}

function createCdpBrowser ({
  launcher,
  cdpClient,
  onFrame,
  onEvent = () => {},
  isWebsiteUrl = isHttpUrl,
  maxSessions = DEFAULT_MAX_SESSIONS,
  frameQuality = DEFAULT_FRAME_QUALITY,
  defaultUserAgent = null,
  log = console
} = {}) {
  if (typeof launcher !== 'function') {
    throw new TypeError('CDP browser requires a launcher')
  }
  if (typeof cdpClient !== 'function') {
    throw new TypeError('CDP browser requires a cdpClient factory')
  }
  const sessions = new Map()
  const warn = (...args) => { if (log && typeof log.warn === 'function') log.warn(...args) }

  // Every CDP call is guarded so a closed target or a fake missing a method
  // never throws out of the engine.
  async function send (entry, method, params) {
    if (!entry || entry.closed || !entry.client) return undefined
    try {
      return await entry.client.send(method, params || {})
    } catch (error) {
      warn('CDP ' + method + ' failed:', error && error.message)
      return undefined
    }
  }

  async function startScreencast (entry) {
    return send(entry, 'Page.startScreencast', {
      format: 'jpeg',
      quality: frameQuality,
      maxWidth: entry.width,
      maxHeight: entry.height
    })
  }

  function wireEvents (entry) {
    const client = entry.client
    const on = (name, fn) => { if (typeof client.on === 'function') client.on(name, fn) }

    on('Page.screencastFrame', (payload) => {
      const p = payload || {}
      if (!entry.closed && onFrame && typeof p.data === 'string') {
        let buffer
        try {
          buffer = Buffer.from(p.data, 'base64')
        } catch (error) {
          return warn('CDP frame decode failed:', error && error.message)
        }
        if (buffer && buffer.length) onFrame(entry.id, buffer)
      }
      // Acknowledge regardless so Chromium keeps streaming frames.
      if (p.sessionId !== undefined) {
        send(entry, 'Page.screencastFrameAck', { sessionId: p.sessionId })
      }
    })

    const emitNav = () => onEvent(entry.id, { t: 'nav', url: entry.url })
    on('Page.frameNavigated', (payload) => {
      const frame = payload && payload.frame
      if (frame && frame.parentId === undefined) {
        if (typeof frame.url === 'string') entry.url = frame.url
        emitNav()
      }
    })
    on('Page.navigatedWithinDocument', (payload) => {
      const p = payload || {}
      if (typeof p.url === 'string') entry.url = p.url
      emitNav()
    })
    on('Page.frameStartedLoading', () => onEvent(entry.id, { t: 'loading', state: 'start' }))
    on('Page.loadEventFired', () => onEvent(entry.id, { t: 'loading', state: 'done' }))
    on('Page.frameStoppedLoading', () => onEvent(entry.id, { t: 'loading', state: 'done' }))
    on('Page.loadingFailed', (payload) => {
      const p = payload || {}
      onEvent(entry.id, { t: 'error', code: p.errorText || 'ERR_FAILED' })
    })
    on('Target.targetInfoChanged', (payload) => {
      const info = payload && payload.targetInfo
      if (info && typeof info.title === 'string') onEvent(entry.id, { t: 'title', title: info.title })
    })
  }

  async function open ({ id, url, width, height, dpr, userAgent, engine } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('Invalid browser session id')
    const existing = sessions.get(id)
    if (existing) {
      if (url && isWebsiteUrl(url)) {
        existing.url = url
        await send(existing, 'Page.navigate', { url })
      }
      return { id }
    }
    if (!isWebsiteUrl(url)) throw new Error('Only http(s) targets are allowed')
    if (sessions.size >= maxSessions) throw new Error('Too many browser sessions')
    const w = clampDimension(width, 1280)
    const h = clampDimension(height, 720)
    // 'edge' launches Microsoft Edge; anything else (incl. 'chrome') launches
    // Chrome. The launcher only knows which browser to spawn from this field.
    const browser = engine === 'edge' ? 'edge' : 'chrome'
    const handle = await launcher({ id, url, width: w, height: h, browser })
    let entry
    try {
      const client = await cdpClient(handle)
      entry = {
        id,
        handle,
        client,
        width: w,
        height: h,
        dpr: Number(dpr) > 0 ? Number(dpr) : 1,
        url,
        closed: false
      }
      sessions.set(id, entry)
      wireEvents(entry)
      await send(entry, 'Page.enable')
      await send(entry, 'Network.enable')
      // Per-session UA override wins over defaultUserAgent and MUST be applied
      // before navigate so the very first request carries it.
      const effectiveUserAgent = isValidUserAgent(userAgent)
        ? userAgent
        : (isValidUserAgent(defaultUserAgent) ? defaultUserAgent : null)
      if (effectiveUserAgent) {
        await send(entry, 'Network.setUserAgentOverride', { userAgent: effectiveUserAgent })
      }
      if (Number(dpr) > 0) {
        await send(entry, 'Emulation.setDeviceMetricsOverride', {
          width: w, height: h, deviceScaleFactor: entry.dpr, mobile: false
        })
      }
      await send(entry, 'Page.navigate', { url })
      await startScreencast(entry)
      return { id }
    } catch (error) {
      // A failed or aborted open must never leave the just-launched browser
      // process running (observed: orphaned chrome from opens that threw after
      // the launch), so reap the handle before re-throwing.
      if (entry) {
        sessions.delete(id)
        destroy(entry)
      } else {
        try { if (handle && typeof handle.close === 'function') handle.close() } catch {}
        try { if (handle && typeof handle.kill === 'function') handle.kill() } catch {}
      }
      throw error
    }
  }

  async function input ({ id, t, kind, x, y, button, buttons, clickCount, modifiers, dx, dy, key } = {}) {
    const entry = sessions.get(id)
    if (!entry || entry.closed) return
    const mods = cdpModifiers(modifiers || 0)
    if (t === 'mouse') {
      if (kind === 'wheel') {
        return send(entry, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: x || 0,
          y: y || 0,
          deltaX: dx || 0,
          deltaY: dy || 0,
          modifiers: mods
        })
      }
      const type = kind === 'down' ? 'mousePressed' : kind === 'up' ? 'mouseReleased' : 'mouseMoved'
      const event = { type, x: x || 0, y: y || 0, modifiers: mods }
      if (kind === 'down' || kind === 'up') {
        event.button = mouseButton(button)
        event.clickCount = clickCount || 1
      } else {
        event.button = 'none'
      }
      return send(entry, 'Input.dispatchMouseEvent', event)
    }
    if (t === 'key') {
      const keyCode = keyFor(key)
      if (kind === 'char') {
        if (keyCode) await send(entry, 'Input.dispatchKeyEvent', { type: 'char', text: keyCode, modifiers: mods })
        return
      }
      if (!keyCode) return
      return send(entry, 'Input.dispatchKeyEvent', {
        type: kind === 'up' ? 'keyUp' : 'keyDown',
        key: keyCode,
        modifiers: mods
      })
    }
  }

  async function resize ({ id, width, height, dpr } = {}) {
    const entry = sessions.get(id)
    if (!entry || entry.closed) return
    entry.width = clampDimension(width, entry.width)
    entry.height = clampDimension(height, entry.height)
    if (Number(dpr) > 0) entry.dpr = Number(dpr)
    await send(entry, 'Emulation.setDeviceMetricsOverride', {
      width: entry.width,
      height: entry.height,
      deviceScaleFactor: entry.dpr,
      mobile: false
    })
    await send(entry, 'Page.stopScreencast')
    await startScreencast(entry)
  }

  async function nav ({ id, action, url } = {}) {
    const entry = sessions.get(id)
    if (!entry || entry.closed) return
    if (action === 'goto' && url && isWebsiteUrl(url)) {
      entry.url = url
      return send(entry, 'Page.navigate', { url })
    }
    if (action === 'reload') {
      return send(entry, 'Page.reload', {})
    }
    if (action === 'back' || action === 'forward') {
      const history = await send(entry, 'Page.getNavigationHistory')
      if (!history || !Array.isArray(history.entries)) return
      const index = Number(history.currentIndex)
      const target = action === 'back' ? index - 1 : index + 1
      const dest = history.entries[target]
      if (dest && dest.id !== undefined) {
        return send(entry, 'Page.navigateToHistoryEntry', { entryId: dest.id })
      }
    }
  }

  function destroy (entry) {
    Promise.resolve(send(entry, 'Page.stopScreencast')).catch(() => {})
    entry.closed = true
    const handle = entry.handle
    if (entry.client && typeof entry.client.close === 'function') {
      try { entry.client.close() } catch {}
    }
    if (handle && typeof handle.close === 'function') {
      try { handle.close() } catch {}
    } else if (handle && typeof handle.kill === 'function') {
      try { handle.kill() } catch {}
    }
  }

  function close ({ id } = {}) {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    destroy(entry)
  }

  function disposeAll () {
    for (const id of [...sessions.keys()]) close({ id })
  }

  // Export every cookie the browser knows about as a plain array, so an
  // authenticated session can be carried elsewhere.
  async function exportCookies ({ id } = {}) {
    const entry = sessions.get(id)
    if (!entry || entry.closed) throw new Error('Browser session not found')
    const res = await send(entry, 'Network.getAllCookies')
    return (res && Array.isArray(res.cookies)) ? res.cookies : []
  }

  // Load an array of previously exported cookies. Each cookie is best-effort: a
  // malformed entry is skipped rather than aborting the whole import. Returns the
  // number of cookies successfully prepared and sent.
  async function importCookies ({ id, cookies } = {}) {
    const entry = sessions.get(id)
    if (!entry || entry.closed) throw new Error('Browser session not found')
    if (!Array.isArray(cookies)) return 0
    const prepared = []
    for (const cookie of cookies) {
      if (!cookie || typeof cookie.name !== 'string' || !cookie.name) continue
      const bareDomain = String(cookie.domain || '').replace(/^\./, '')
      if (!bareDomain) continue
      const path = cookie.path || '/'
      const scheme = cookie.secure ? 'https' : 'http'
      const details = {
        url: `${scheme}://${bareDomain}${path}`,
        name: cookie.name,
        value: typeof cookie.value === 'string' ? cookie.value : '',
        domain: cookie.domain,
        path,
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly
      }
      if (typeof cookie.expirationDate === 'number') details.expires = cookie.expirationDate
      if (cookie.sameSite) details.sameSite = cookie.sameSite
      prepared.push(details)
    }
    if (!prepared.length) return 0
    await send(entry, 'Network.setCookies', { cookies: prepared })
    return prepared.length
  }

  return {
    open,
    input,
    resize,
    nav,
    close,
    exportCookies,
    importCookies,
    disposeAll,
    count: () => sessions.size,
    // CDP has no offscreen window pool (each session owns a real browser target);
    // exposed as a constant 0 purely for literal interface parity with rbi-browser.
    poolSize: () => 0,
    _sessions: sessions
  }
}

module.exports = { createCdpBrowser, isHttpUrl }
