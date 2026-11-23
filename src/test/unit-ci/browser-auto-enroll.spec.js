const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ensureInstallationIdentity,
  rememberInstallationIdentity,
  browserEnrollmentHandlers,
  browserKey,
  DEVICE_URL
} = require('../../app/lib/browser-auto-enroll')

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SECRET = 'ab'.repeat(32)
const OTHER_SECRET = 'cd'.repeat(32)

function workspace () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-enroll-'))
  const userData = path.join(root, 'profile', 'user')
  fs.mkdirSync(userData, { recursive: true })
  return {
    root,
    userData,
    stable: path.join(root, 'machine-identity.json'),
    profile: path.join(userData, 'managed-access-identity.json'),
    browser: path.join(root, 'machine-browser.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('installation identity prefers the machine store, then the stable file, then the profile', () => {
  const dir = workspace()
  try {
    const stored = { id: ID, secret: SECRET }
    fs.writeFileSync(dir.stable, JSON.stringify({ id: OTHER, secret: OTHER_SECRET }))
    let written = null
    const fromStore = ensureInstallationIdentity(dir.userData, {
      machineStore: {
        read: () => stored,
        write: value => { written = value }
      }
    })
    assert.equal(fromStore.id, ID)
    assert.deepEqual(readJson(dir.stable), stored)
    assert.deepEqual(readJson(dir.profile), stored)
    assert.deepEqual(written, stored)
    assert.equal(fs.statSync(dir.stable).mode & 0o777, 0o600)

    fs.writeFileSync(dir.stable, JSON.stringify({ id: 'not-a-uuid', secret: 'short' }))
    fs.writeFileSync(dir.profile, JSON.stringify({ id: OTHER, secret: OTHER_SECRET }))
    const fromProfile = ensureInstallationIdentity(dir.userData, {
      machineStore: { read: () => null, write () {} }
    })
    assert.equal(fromProfile.id, OTHER)
    assert.deepEqual(readJson(dir.stable), { id: OTHER, secret: OTHER_SECRET })

    const past = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(dir.profile, past, past)
    ensureInstallationIdentity(dir.userData, {
      machineStore: { read: () => null, write () {} }
    })
    assert.equal(fs.statSync(dir.profile).mtimeMs, past.getTime())
  } finally {
    dir.cleanup()
  }
})

test('a missing installation identity is created once and a denied machine-store write is ignored', () => {
  const dir = workspace()
  try {
    const store = { read: () => null, write () { throw new Error('registry denied') } }
    const created = ensureInstallationIdentity(dir.userData, { machineStore: store })
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const saved = readJson(dir.stable)
    assert.equal(saved.id, created.id)
    assert.match(saved.secret, /^[0-9a-f]{64}$/)
    assert.deepEqual(readJson(dir.profile), saved)
    const again = ensureInstallationIdentity(dir.userData, { machineStore: store })
    assert.equal(again.id, created.id)
    assert.equal(readJson(dir.stable).secret, saved.secret)
  } finally {
    dir.cleanup()
  }
})

test('remembered identities must be a version-4 id and a 64-character secret', () => {
  const dir = workspace()
  try {
    for (const value of [null, { id: ID }, { id: ID.toUpperCase(), secret: SECRET }, { id: ID, secret: SECRET.slice(0, 63) }, { id: 'bbbbbbbb-bbbb-3bbb-8bbb-bbbbbbbbbbbb', secret: OTHER_SECRET }]) {
      assert.throws(() => rememberInstallationIdentity(dir.userData, value), /Invalid managed installation identity/)
    }
    assert.equal(fs.existsSync(dir.stable), false)
    const saved = rememberInstallationIdentity(dir.userData, { id: ID, secret: SECRET })
    assert.equal(saved.id, ID)
    assert.deepEqual(readJson(dir.stable), { id: ID, secret: SECRET })
    assert.deepEqual(readJson(dir.profile), { id: ID, secret: SECRET })
  } finally {
    dir.cleanup()
  }
})

test('browser enrollment reuses a device key and installs a new control-center identity only when needed', () => {
  const dir = workspace()
  try {
    const idle = browserEnrollmentHandlers(dir.userData, { get: () => undefined })
    assert.equal(idle.browserEnrollment({ id: 'not-a-uuid', label: 'desk' }), null)
    assert.equal(fs.existsSync(dir.browser), false)
    const enrolled = idle.browserEnrollment({ id: ID, label: 'desk' })
    assert.equal(enrolled.deviceId, 'm' + ID.replace(/-/g, ''))
    assert.equal(enrolled.deviceName, 'desk')
    const again = browserKey(dir.userData, ID)
    assert.equal(again.publicKey, enrolled.publicKey)
    assert.equal(again.privateKey.length > 0, true)
    assert.equal(fs.statSync(dir.browser).mode & 0o777, 0o600)
    assert.equal(browserEnrollmentHandlers(dir.userData, { get: () => undefined }).browserEnrollment({ id: ID }).deviceName, os.hostname())

    const replaced = browserKey(dir.userData, OTHER)
    assert.equal(replaced.managementId, OTHER)
    assert.notEqual(replaced.deviceId, enrolled.deviceId)
    fs.writeFileSync(dir.browser, '{')
    assert.throws(() => browserKey(dir.userData, ID))
    fs.unlinkSync(dir.browser)

    const key = browserKey(dir.userData, ID)
    const installed = []
    const status = { enrolled: true, deviceId: key.deviceId, state: 'online', settings: { url: DEVICE_URL } }
    const handlers = browserEnrollmentHandlers(dir.userData, {
      get: name => name === 'controlCenter' ? { status: () => status, installIdentity: value => installed.push(value) } : undefined
    })
    handlers.onBrowserEnrolled({})
    handlers.onBrowserEnrolled({ deviceId: 'other', keyId: 'k', serverPublicKey: 's' })
    for (const state of ['online', 'connecting', 'backoff']) {
      status.state = state
      handlers.onBrowserEnrolled({ deviceId: key.deviceId, keyId: 'skip', serverPublicKey: 'server' })
    }
    assert.equal(installed.length, 0)
    status.state = 'offline'
    handlers.onBrowserEnrolled({ deviceId: key.deviceId, keyId: 'key-1', serverPublicKey: 'server-key', url: 'wss://control.example/ws' })
    assert.deepEqual(installed, [{
      deviceId: key.deviceId,
      keyId: 'key-1',
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      serverPublicKey: 'server-key',
      url: 'wss://control.example/ws'
    }])
    delete status.settings
    handlers.onBrowserEnrolled({ deviceId: key.deviceId, keyId: 'key-2', serverPublicKey: 'server-key' })
    assert.equal(installed[1].url, DEVICE_URL)
  } finally {
    dir.cleanup()
  }
})
