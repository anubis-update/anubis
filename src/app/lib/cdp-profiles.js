/**
 * Read-only browser profile enumeration from `Local State` (profile.info_cache).
 * Nothing is written and no paths/secrets leave this module: callers get opaque
 * profile ids; the id -> directory mapping stays internal.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function maskEmail (email) {
  const s = String(email || '')
  const at = s.indexOf('@')
  if (at < 1) return undefined
  return s[0] + '***' + s.slice(at)
}

function profileIdFor (engine, dir) {
  return 'p_' + crypto.createHash('sha256').update(engine + '\0' + dir).digest('hex').slice(0, 10)
}

function createProfileCatalog ({
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  resolveSourceDir
} = {}) {
  const dirs = new Map() // profileId -> { engine, dir }
  const selected = new Map() // engine -> profileId

  function enumerate (engine) {
    const root = resolveSourceDir ? resolveSourceDir(engine) : null
    if (!root) return { profiles: [], available: false }
    let state
    try {
      state = JSON.parse(readFile(path.join(root, 'Local State')))
    } catch {
      return { profiles: [], available: false }
    }
    const cache = (state && state.profile && state.profile.info_cache) || {}
    const lastUsed = state && state.profile && state.profile.last_used
    const profiles = []
    for (const dir of Object.keys(cache)) {
      if (!/^[A-Za-z0-9 _-]{1,64}$/.test(dir)) continue
      if (!exists(path.join(root, dir, 'Preferences'))) continue // ghost entry
      const info = cache[dir] || {}
      const profileId = profileIdFor(engine, dir)
      dirs.set(profileId, { engine, dir })
      const email = maskEmail(info.user_name)
      profiles.push({
        profileId,
        engine,
        name: String(info.name || dir).slice(0, 100),
        ...(email ? { email } : {}),
        isDefault: dir === 'Default',
        ...(dir === lastUsed ? { lastUsed: true } : {})
      })
    }
    return { profiles, available: true }
  }

  function resolve (profileId) {
    const e = dirs.get(profileId)
    return e ? { ...e } : null
  }

  function select (engine, profileId) {
    const e = dirs.get(profileId)
    if (!e || e.engine !== engine) return false
    selected.set(engine, profileId)
    return true
  }

  return { enumerate, resolve, select, selected: (engine) => selected.get(engine) || null }
}

module.exports = { createProfileCatalog, maskEmail, profileIdFor }
