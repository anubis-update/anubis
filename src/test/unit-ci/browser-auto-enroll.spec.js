'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  DEVICE_URL,
  browserEnrollmentHandlers,
  browserKey,
  ensureInstallationIdentity,
  rememberInstallationIdentity
} = require('../../app/lib/browser-auto-enroll')

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SECRET = 'ab'.repeat(32)

function tempUserData () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-enroll-'))
  const userData = path.join(root, 'User', 'Data')
  fs.mkdirSync(userData, { recursive: true })
  return { root, userData }
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('adopted installation identity must be a version-4 id and a 32-byte secret', () => {
  const { userData } = tempUserData()
  const profile = path.join(userData, 'managed-access-identity.json')
  for (const value of [
    null,
    { id: ID, secret: SECRET.toUpperCase() },
    { id: '11111111-1111-1111-8111-111111111111', secret: SECRET },
    { id: '11111111-1111-4111-1111-111111111111', secret: SECRET },
    { id: ID, secret: 'abcd' }
  ]) {
    assert.throws(() => rememberInstallationIdentity(userData, value), /Invalid managed installation identity/)
  }
  assert.equal(fs.existsSync(profile), false)
  const saved = rememberInstallationIdentity(userData, { id: ID, secret: SECRET })
  assert.equal(saved.id, ID)
  assert.deepEqual(readJson(saved.profile), { id: ID, secret: SECRET })
  assert.deepEqual(readJson(saved.stable), { id: ID, secret: SECRET })
  assert.equal(fs.statSync(saved.stable).mode & 0o777, 0o600)
})

test('enrollment reuses the machine copy, then the stable file, and still saves when registry write fails', () => {
  const { userData } = tempUserData()
  const machine = { id: ID, secret: SECRET }
  const stable = { id: OTHER, secret: 'cd'.repeat(32) }
  let writes = 0
  const store = {
    read: () => machine,
    write (value) {
      writes++
      assert.deepEqual(value, machine)
    }
  }
  const adopted = ensureInstallationIdentity(userData, { machineStore: store })
  assert.equal(adopted.id, ID)
  assert.equal(writes, 1)
  assert.deepEqual(readJson(adopted.stable), machine)
  assert.deepEqual(readJson(adopted.profile), machine)

  const fresh = tempUserData()
  fs.writeFileSync(path.join(path.resolve(fresh.userData, '..', '..'), 'machine-identity.json'), JSON.stringify(stable))
  fs.writeFileSync(path.join(fresh.userData, 'managed-access-identity.json'), '{')
  const restored = ensureInstallationIdentity(fresh.userData, {
    machineStore: { read: () => null, write () { throw new Error('registry denied') } }
  })
  assert.equal(restored.id, OTHER)
  assert.deepEqual(readJson(restored.profile), stable)

  const created = tempUserData()
  let generated
  const minted = ensureInstallationIdentity(created.userData, {
    machineStore: {
      read: () => null,
      write (value) { generated = value }
    }
  })
  assert.equal(minted.id, generated.id)
  assert.match(generated.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(generated.secret, /^[0-9a-f]{64}$/)
  assert.deepEqual(readJson(minted.profile), generated)
})

test('browser enrollment keeps one key per management id and installs it only for that device', () => {
  const { userData } = tempUserData()
  assert.throws(() => browserKey(userData, 'not-a-device'), /Invalid management identity/)
  const key = browserKey(userData, ID)
  assert.equal(key.deviceId, 'm' + ID.replace(/-/g, ''))
  assert.equal(key.managementId, ID)
  assert.equal(browserKey(userData, ID).publicKey, key.publicKey)
  const publicKey = crypto.createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' })
  assert.equal(publicKey.asymmetricKeyType, 'ed25519')
  const broken = path.join(path.resolve(userData, '..', '..'), 'machine-browser.json')
  fs.writeFileSync(broken, '{')
  assert.throws(() => browserKey(userData, ID), SyntaxError)

  const again = tempUserData()
  const saved = browserKey(again.userData, ID)
  const installed = []
  let control = {
    status: () => ({ enrolled: false, state: 'offline' }),
    installIdentity: value => installed.push(value)
  }
  const handlers = browserEnrollmentHandlers(again.userData, {
    get: name => name === 'controlCenter' ? control : undefined
  })
  assert.equal(handlers.browserEnrollment({ id: 'bad', label: 'pc' }), null)
  const body = handlers.browserEnrollment({ id: ID, label: 'pc' })
  assert.deepEqual(body, { deviceId: saved.deviceId, publicKey: saved.publicKey, deviceName: 'pc' })
  handlers.onBrowserEnrolled({ deviceId: saved.deviceId, keyId: 'k' })
  handlers.onBrowserEnrolled({ deviceId: 'other', keyId: 'k', serverPublicKey: 'server' })
  assert.equal(installed.length, 0)
  handlers.onBrowserEnrolled({ deviceId: saved.deviceId, keyId: 'key-1', serverPublicKey: 'server-key' })
  assert.deepEqual(installed, [{
    deviceId: saved.deviceId,
    keyId: 'key-1',
    publicKey: saved.publicKey,
    privateKey: saved.privateKey,
    serverPublicKey: 'server-key',
    url: DEVICE_URL
  }])
  control = {
    status: () => ({
      enrolled: true,
      deviceId: saved.deviceId,
      state: 'online',
      settings: { url: 'wss://fleet.example/ws' }
    }),
    installIdentity: value => installed.push(value)
  }
  handlers.onBrowserEnrolled({
    deviceId: saved.deviceId,
    keyId: 'key-2',
    serverPublicKey: 'server-key',
    url: 'wss://fleet.example/ws'
  })
  assert.equal(installed.length, 1)
  handlers.onBrowserEnrolled({
    deviceId: saved.deviceId,
    keyId: 'key-3',
    serverPublicKey: 'server-key',
    url: 'wss://fleet.example/ws'
  })
  assert.equal(installed.length, 1)
  control.status = () => ({
    enrolled: true,
    deviceId: saved.deviceId,
    state: 'offline',
    settings: { url: 'wss://fleet.example/ws' }
  })
  handlers.onBrowserEnrolled({
    deviceId: saved.deviceId,
    keyId: 'key-4',
    serverPublicKey: 'server-key',
    url: 'wss://fleet.example/ws'
  })
  assert.equal(installed.length, 2)
  assert.equal(installed[1].keyId, 'key-4')
  assert.equal(installed[1].url, 'wss://fleet.example/ws')
})
