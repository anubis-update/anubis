/**
 * Persistent Control Center identity: deviceId, Ed25519 private key (wrapped by
 * `protect`, e.g. OS safeStorage/DPAPI), pinned server public key, URL and the
 * kill flag. The file is written with mode 0600. Private key is never returned
 * by public(), never logged.
 */

function createControlStore ({ io, protect = (s) => s, unprotect = (s) => s } = {}) {
  if (!io || typeof io.read !== 'function' || typeof io.write !== 'function') throw new TypeError('store requires io.read/io.write')
  let cache
  const load = () => {
    if (cache === undefined) {
      let doc = null
      try { doc = io.read() } catch {
        throw Object.assign(new Error('Control Center identity could not be read'), { code: 'STATE_READ_FAILED' })
      }
      if (doc !== null && doc !== undefined && (typeof doc !== 'object' || Array.isArray(doc) || doc.v !== 1)) {
        throw Object.assign(new Error('Control Center identity is invalid'), { code: 'STATE_READ_FAILED' })
      }
      cache = doc && typeof doc === 'object' ? doc : null
    }
    return cache
  }
  const persist = (doc) => {
    try { io.write(doc) } catch {
      throw Object.assign(new Error('Control Center identity could not be saved'), { code: 'STATE_WRITE_FAILED' })
    }
    cache = doc
  }
  return {
    identity () {
      const d = load()
      if (!d || !d.privateKey || !d.deviceId) return null
      let privateKey
      try { privateKey = unprotect(d.privateKey) } catch {
        throw Object.assign(new Error('Control Center signing key could not be unlocked'), { code: 'STATE_READ_FAILED' })
      }
      if (typeof privateKey !== 'string' || !privateKey) {
        throw Object.assign(new Error('Control Center signing key is unavailable'), { code: 'STATE_READ_FAILED' })
      }
      return { deviceId: d.deviceId, keyId: d.keyId, publicKey: d.publicKey, privateKey, serverPublicKey: d.serverPublicKey, url: d.url }
    },
    isProtected () {
      const d = load()
      return !!(d && d.privateKey && d.privateKey !== unprotect(d.privateKey))
    },
    saveIdentity ({ deviceId, keyId, publicKey, privateKey, serverPublicKey, url }) {
      persist({ v: 1, deviceId, keyId, publicKey, privateKey: protect(privateKey), serverPublicKey, url, killed: false })
    },
    killed () { const d = load(); return !!(d && d.killed) },
    setKilled (flag) {
      const d = load()
      persist({ ...(d || { v: 1 }), killed: !!flag })
    },
    clear () { persist(null) }
  }
}

module.exports = { createControlStore }
