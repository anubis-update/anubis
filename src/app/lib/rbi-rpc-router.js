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

function createRbiRpcRouter ({ getRbiBrowser, getCdpBrowser } = {}) {
  if (typeof getRbiBrowser !== 'function') {
    throw new TypeError('rbi rpc router requires getRbiBrowser')
  }
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
