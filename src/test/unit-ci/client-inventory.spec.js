const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createClientInventory, normalizeClientInventory, script } = require('../../app/lib/client-inventory')

const record = () => ({
  version: 1,
  status: 'ok',
  collectedAt: null,
  role: 'system',
  security: { status: 'ok', products: ['Microsoft Defender Antivirus'] },
  software: { status: 'ok', scope: 'machine+current-user', truncated: false, items: [{ name: 'Anubis', version: '5.7.44' }] }
})
function child () {
  const instance = new EventEmitter()
  instance.stdout = new PassThrough()
  instance.stderr = new PassThrough()
  instance.kill = () => { instance.killed = true; return true }
  return instance
}

test('client inventory schema bounds software and role and excludes paths, account names and unexpected fields', () => {
  const raw = record()
  raw.secret = 'must-not-survive'
  raw.software.items[0].path = 'C:\\private'
  assert.equal(normalizeClientInventory(raw).secret, undefined)
  assert.deepEqual(normalizeClientInventory(raw).software.items[0], { name: 'Anubis', version: '5.7.44' })
  for (const invalid of [
    { ...record(), role: 'elevated-guessed' },
    { ...record(), collectedAt: -1 },
    { ...record(), security: { status: 'ok', products: ['unsafe\nname'] } },
    { ...record(), software: { ...record().software, items: Array.from({ length: 101 }, () => ({ name: 'A', version: '' })) } }
  ]) assert.throws(() => normalizeClientInventory(invalid))
  const addressed = record()
  addressed.ipv4 = [
    '10.1.2.3',
    '10.1.2.3',
    '127.0.0.1',
    '127.1.1.1',
    '169.254.4.5',
    '169.1.1.1',
    '10.0.0.256',
    'not-an-ip',
    '2001:db8::1',
    '8.8.8.8',
    '1.1.1.1',
    '9.9.9.9',
    '4.4.4.4',
    '1.0.0.1',
    '8.8.4.4',
    '9.9.9.10'
  ]
  addressed.security.products = [{ name: 'Defender', enabled: false }]
  assert.deepEqual(normalizeClientInventory(addressed).ipv4, [
    '10.1.2.3', '169.1.1.1', '8.8.8.8', '1.1.1.1', '9.9.9.9', '4.4.4.4', '1.0.0.1', '8.8.4.4'
  ])
  assert.deepEqual(normalizeClientInventory(addressed).security.products, [{ name: 'Defender', enabled: false }])
  const longName = 'A'.repeat(160)
  const bounded = record()
  bounded.software.items[0].name = longName
  assert.equal(normalizeClientInventory(bounded).software.items[0].name, longName)
  for (const name of ['A'.repeat(161), 'A\u007fB', 'A\tB', ' Anubis']) {
    const invalidName = record()
    invalidName.software.items[0].name = name
    assert.throws(() => normalizeClientInventory(invalidName))
  }
  const badEnabled = record()
  badEnabled.security.products = [{ name: 'Defender', enabled: 'yes' }]
  assert.throws(() => normalizeClientInventory(badEnabled))
  assert(!script().includes('Win32_Product'), 'Software inventory must not trigger MSI reconfiguration')
  assert(!script().includes('UninstallString'))
  assert(script().includes('WindowsBuiltInRole'))
  assert(script().includes('SecurityCenter2'))
})

test('client collection is cached, single-flight, bounded, and safely decodes split UTF-8 product names', async () => {
  let time = 10
  let calls = 0
  let launched
  const collector = createClientInventory({
    platform: 'win32',
    now: () => time,
    onError: error => assert.fail(error.message),
    spawn (command, args, options) {
      calls++
      assert(command.endsWith('\\powershell.exe'))
      assert.equal(options.shell, false)
      assert.equal(args[0], '-NoProfile')
      launched = child()
      return launched
    }
  })
  assert.equal(collector.get().status, 'collecting')
  const pending = collector.wait()
  assert.equal(calls, 1)
  const raw = record()
  raw.software.items[0].name = 'Приложение'
  const bytes = Buffer.from('ANUBIS_CLIENT_INVENTORY ' + JSON.stringify(raw) + '\n')
  const split = bytes.indexOf(Buffer.from('Приложение')) + 1
  launched.stdout.write(bytes.subarray(0, split))
  launched.stdout.write(bytes.subarray(split))
  launched.emit('close', 0)
  const result = await pending
  assert.equal(result.software.items[0].name, 'Приложение')
  assert.equal(result.collectedAt, 10)
  collector.get()
  assert.equal(calls, 1)
  time += 15 * 60 * 1000
  collector.get()
  assert.equal(calls, 2)
  launched.stdout.write('ANUBIS_CLIENT_INVENTORY ' + JSON.stringify(raw))
  launched.emit('close', 0)
  await collector.wait()
})

test('collection reports timeout, excessive output and malformed snapshots explicitly without claiming success', async () => {
  for (const mode of ['timeout', 'oversize', 'invalid']) {
    let launched
    const errors = []
    const collector = createClientInventory({
      platform: 'win32',
      timeoutMs: 10,
      onError: error => errors.push(error),
      spawn () {
        launched = child()
        if (mode !== 'timeout') {
          setImmediate(() => {
            launched.stdout.write(mode === 'oversize' ? 'x'.repeat(130 * 1024) : 'ANUBIS_CLIENT_INVENTORY {"version":1}')
            launched.emit('close', 0)
          })
        }
        return launched
      }
    })
    const value = await collector.wait()
    assert.equal(value.status, mode === 'timeout' ? 'timeout' : 'error')
    assert.equal(errors.length, 1)
    if (mode !== 'invalid') assert.equal(launched.killed, true)
  }
  const unsupported = createClientInventory({ platform: 'linux', spawn: () => assert.fail('Unsupported platform must not launch PowerShell') })
  assert.equal((await unsupported.wait()).status, 'unavailable')
})
