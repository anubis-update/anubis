/**
 * Engine router for the managed browser control plane.
 *
 * The server child names a fixed set of `rbi*` RPC functions (open/input/nav/
 * resize/close/exportCookies/importCookies). This router maps each call onto the
 * engine that OWNS the session id: `rbiOpen` reads an `engine` field
 * ('rbi' | 'chrome' | 'edge', default 'rbi') and remembers the owning engine for
 * that id, so every later call for the same id dispatches to the same engine
 * with zero client-visible protocol change. 'chrome'/'edge' both map to the CDP
 * engine; anything else is the internal RBI engine.
 *
 * Engines are resolved lazily through getters so the router can be constructed
 * before either engine exists, and a clear error is thrown if a required engine
 * is not ready.
 */

const METHODS = {
  rbiOpen: 'open',
  rbiInput: 'input',
  rbiNav: 'nav',
  rbiResize: 'resize',
  rbiClose: 'close',
  rbiExportCookies: 'exportCookies',
  rbiImportCookies: 'importCookies'
}

function engineNameFor (engine) {
  return (engine === 'chrome' || engine === 'edge') ? 'cdp' : 'rbi'
}

function codedError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createRbiRpcRouter ({ getRbiBrowser, getCdpBrowser, isSystemRuntime } = {}) {
  if (typeof getRbiBrowser !== 'function') {
    throw new TypeError('rbi rpc router requires getRbiBrowser')
  }
  const inSystemRuntime = typeof isSystemRuntime === 'function' ? isSystemRuntime : () => false
  const owners = new Map()

  function resolveEngine (name) {
    if (name === 'cdp') {
      const cdp = typeof getCdpBrowser === 'function' ? getCdpBrowser() : null
      if (!cdp) throw new Error('Chrome/Edge browser engine is not ready')
      return cdp
    }
    const rbi = getRbiBrowser()
    if (!rbi) throw new Error('RBI browser is not ready')
    return rbi
  }

  function handles (func) {
    return Object.prototype.hasOwnProperty.call(METHODS, func)
  }

  function dispatch (func, args) {
    const method = METHODS[func]
    if (!method) throw new Error('Unknown browser control function: ' + func)
    const arg = (args && args[0]) || {}
    const id = typeof arg.id === 'string' ? arg.id : null

    if (func === 'rbiOpen') {
      const name = engineNameFor(arg.engine)
      // Chrome/Edge must run in the logged-on user's context (session >= 1) so
      // it reaches the real profile and shows a visible window. In the SYSTEM
      // machine runtime (session 0) there is no user desktop or profile, so
      // reject deterministically instead of launching an invisible, empty
      // browser; the client maps this code to a "select your Windows workspace
      // context" note.
      if (name === 'cdp' && inSystemRuntime()) {
        throw codedError('USER_CONTEXT_REQUIRED', 'Chrome/Edge needs your Windows workspace context. Open the context selector, choose your workspace, then try again.')
      }
      if (id) owners.set(id, name)
      return resolveEngine(name)[method](arg)
    }

    const name = (id && owners.has(id)) ? owners.get(id) : 'rbi'
    const engine = resolveEngine(name)
    if (func === 'rbiClose' && id) owners.delete(id)
    return engine[method](arg)
  }

  return { dispatch, handles, engineNameFor, _owners: owners }
}

module.exports = { createRbiRpcRouter, engineNameFor }
