'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DEVICE_URL = 'wss://control.anubis.locker/ws/v1/device'

function readIdentity (file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!UUID.test(value.id) || !/^[0-9a-f]{64}$/.test(value.secret)) return null
    return { id: value.id, secret: value.secret }
  } catch { return null }
}

function writeIdentity (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function stableRoot (userData) {
  return path.resolve(userData, '..', '..')
}

const INSTALLATION_KEY = 'HKLM\\SOFTWARE\\Anubis-Security-Tool\\Installation'

function queryRegistryValue (name) {
  const output = require('node:child_process').execFileSync('reg.exe', [
    'query', INSTALLATION_KEY, '/v', name
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const line = output.split(/\r?\n/).find(item => item.includes(name))
  const value = line && /REG_\w+\s+(\S+)\s*$/.exec(line)
  return value ? value[1] : ''
}

function windowsInstallationStore () {
  return {
    read () {
      try {
        const id = queryRegistryValue('Id')
        const secret = queryRegistryValue('Secret')
        if (!UUID.test(id) || !/^[0-9a-f]{64}$/.test(secret)) return null
        return { id, secret }
      } catch { return null }
    },
    write (value) {
      const reg = require('node:child_process').execFileSync
      reg('reg.exe', ['add', INSTALLATION_KEY, '/v', 'Id', '/t', 'REG_SZ', '/d', value.id, '/f'], { windowsHide: true, stdio: 'ignore' })
      reg('reg.exe', ['add', INSTALLATION_KEY, '/v', 'Secret', '/t', 'REG_SZ', '/d', value.secret, '/f'], { windowsHide: true, stdio: 'ignore' })
    }
  }
}

function machineInstallationStore () {
  if (process.platform !== 'win32' || !process.env.ANUBIS_MACHINE_CONTEXT_SERVICE) {
    return { read () { return null }, write () {} }
  }
  return windowsInstallationStore()
}

function rememberInstallationIdentity (userData, value) {
  if (!value || !UUID.test(value.id) || !/^[0-9a-f]{64}$/.test(value.secret)) throw new Error('Invalid managed installation identity')
  const profile = path.join(userData, 'managed-access-identity.json')
  const stable = path.join(stableRoot(userData), 'machine-identity.json')
  writeIdentity(stable, value)
  writeIdentity(profile, value)
  try { machineInstallationStore().write(value) } catch {}
  return { profile, stable, id: value.id }
}

function ensureInstallationIdentity (userData, options = {}) {
  const profile = path.join(userData, 'managed-access-identity.json')
  const stable = path.join(stableRoot(userData), 'machine-identity.json')
  const store = options.machineStore || machineInstallationStore()
  // The registry copy survives deletion of ProgramData. A reinstall of the same
  // PC must enroll as the already approved device and come online, not as a new
  // pending record.
  const saved = store.read() || readIdentity(stable) || readIdentity(profile) || {
    id: crypto.randomUUID(),
    secret: crypto.randomBytes(32).toString('hex')
  }
  writeIdentity(stable, saved)
  if (JSON.stringify(readIdentity(profile)) !== JSON.stringify(saved)) writeIdentity(profile, saved)
  try { store.write(saved) } catch {}
  return { profile, stable, id: saved.id }
}

function browserKey (userData, managementId) {
  if (!UUID.test(managementId)) throw new Error('Invalid management identity')
  const deviceId = 'm' + managementId.replace(/-/g, '')
  const file = path.join(stableRoot(userData), 'machine-browser.json')
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.deviceId === deviceId && value.managementId === managementId &&
        typeof value.publicKey === 'string' && typeof value.privateKey === 'string') return value
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const value = {
    deviceId,
    managementId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  return value
}

function installTunnelHook (userData, globalState) {
  const ws = require('ws')
  if (ws.WebSocket.__anubisBrowserHook) return
  const Original = ws.WebSocket
  function WebSocket (...args) {
    const sock = new Original(...args)
    const address = args[0]
    const href = typeof address === 'string' ? address : address?.href || ''
    const managementId = /\/api\/agents\/([0-9a-f-]{36})\/tunnel(?:\?|$)/.exec(href)?.[1]
    if (managementId) {
      const handlers = browserEnrollmentHandlers(userData, globalState)
      sock.on('message', data => {
        let message
        try { message = JSON.parse(data.toString()) } catch { return }
        if (message.type === 'welcome') {
          Promise.resolve(handlers.browserEnrollment({ id: managementId, label: require('node:os').hostname() })).then(body => {
            if (!body || sock.readyState !== Original.OPEN) return
            sock.send(JSON.stringify({
              type: 'browser-enroll',
              deviceId: body.deviceId,
              publicKey: body.publicKey,
              deviceName: body.deviceName
            }))
          }).catch(() => {})
        } else if (message.type === 'browser-enrolled') {
          try { handlers.onBrowserEnrolled(message) } catch {}
        }
      })
    }
    return sock
  }
  Object.setPrototypeOf(WebSocket, Original)
  WebSocket.prototype = Original.prototype
  WebSocket.__anubisBrowserHook = true
  ws.WebSocket = WebSocket
}

function browserEnrollmentHandlers (userData, globalState) {
  return {
    browserEnrollment ({ id, label }) {
      if (!UUID.test(id)) return null
      const key = browserKey(userData, id)
      return { deviceId: key.deviceId, publicKey: key.publicKey, deviceName: label || require('node:os').hostname() }
    },
    onBrowserEnrolled (message) {
      if (!message || typeof message.deviceId !== 'string' || typeof message.keyId !== 'string' || typeof message.serverPublicKey !== 'string') return
      const file = path.join(stableRoot(userData), 'machine-browser.json')
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved.deviceId !== message.deviceId) return
      const cc = globalState.get('controlCenter')
      if (!cc) return
      const url = message.url || DEVICE_URL
      const current = cc.status()
      if (current.enrolled && current.deviceId === message.deviceId && current.settings?.url === url &&
          ['online', 'connecting', 'backoff'].includes(current.state)) return
      cc.installIdentity({
        deviceId: message.deviceId,
        keyId: message.keyId,
        publicKey: saved.publicKey,
        privateKey: saved.privateKey,
        serverPublicKey: message.serverPublicKey,
        url
      })
    }
  }
}

module.exports = { ensureInstallationIdentity, rememberInstallationIdentity, browserEnrollmentHandlers, installTunnelHook, browserKey, DEVICE_URL }
