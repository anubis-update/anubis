'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fleet = require('../../app/lib/fleet-directory')
const { createFleetRuntime } = require('../../app/lib/fleet-runtime')

const document = {
  revision: 5,
  directory: [
    'https://devices.anubis.locker/fleet.json',
    'https://raw.githubusercontent.com/anubis-cloud/fleet-config/main/fleet.json'
  ],
  gateways: [
    { id: 'vps1', primary: 'devices-anubis.pw', backup: 'devices-anubis.online', weight: 1 },
    { id: 'vps2', primary: 'devices-anubis.pro', backup: 'devices-anubis.space', weight: 1 }
  ]
}

test('fleet document accepts the published gateway list and rejects secrets in directory URLs', () => {
  const parsed = fleet.validate(document)
  assert.equal(parsed.gateways.length, 2)
  assert.throws(() => fleet.validate({ ...document, directory: ['https://user:secret@devices.anubis.locker/fleet.json'] }))
  assert.equal(fleet.chooseGateway('device-a', parsed.gateways).id, fleet.chooseGateway('device-a', parsed.gateways).id)
  const moved = fleet.chooseGateway('device-a', parsed.gateways, new Set([parsed.gateways[0].id]))
  assert.notEqual(moved.id, parsed.gateways[0].id)
})

test('a newer fleet revision keeps the assigned gateway and updates its domains', () => {
  const previous = { fleet: fleet.validate(document), gatewayId: 'vps1' }
  const fetched = fleet.validate({
    ...document,
    revision: 6,
    gateways: [
      { id: 'vps1', primary: 'edge-a.example', backup: 'edge-a-backup.example', weight: 1 },
      { id: 'vps2', primary: 'edge-b.example', backup: 'edge-b-backup.example', weight: 1 }
    ]
  })
  const resolved = fleet.resolveAssignment({ deviceId: 'device-a', previous, fetched })
  assert.equal(resolved.gatewayId, 'vps1')
  assert.equal(resolved.fleet.gateways[0].primary, 'edge-a.example')
})

test('runtime uses the directory, then the backup domain, then the other gateway', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-'))
  const bases = []
  let fail
  const runtime = createFleetRuntime({
    userData: dir,
    port: 9,
    header: 'ab'.repeat(32),
    version: '5.7.53',
    failuresBeforeSwitch: 1,
    identityImpl: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    fetchImpl: async () => ({ ok: true, json: async () => document }),
    onStatus (status) { if (status.status === 'offline' && status.error) fail = status.error },
    createAgent ({ baseUrl, onStatus }) {
      bases.push(baseUrl)
      return {
        id: 'agent',
        start () { onStatus({ status: 'offline', error: 'fetch failed' }) },
        stop () {}
      }
    }
  })
  runtime.start()
  try {
    const deadline = Date.now() + 1000
    while (bases.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fail, 'fetch failed')
    assert.ok(bases.length >= 2)
    assert.notEqual(new URL(bases[0]).hostname, new URL(bases[1]).hostname)
  } finally {
    await runtime.stop()
  }
})

test('runtime stays on a gateway until repeated transport failures and ignores other offline errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-threshold-'))
  const bases = []
  let report
  const runtime = createFleetRuntime({
    userData: dir,
    port: 9,
    header: 'ab'.repeat(32),
    version: '5.7.53',
    failuresBeforeSwitch: 3,
    identityImpl: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    fetchImpl: async () => ({ ok: true, json: async () => document }),
    onStatus () {},
    createAgent ({ baseUrl, onStatus }) {
      bases.push(baseUrl)
      report = onStatus
      return { id: 'agent', start () {}, async stop () {} }
    }
  })
  runtime.start()
  try {
    const started = Date.now() + 1000
    while (bases.length < 1 && Date.now() < started) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(bases.length, 1)
    const first = bases[0]
    report({ status: 'offline', error: 'Enrollment rejected: HTTP 403' })
    report({ status: 'offline', error: 'fetch failed' })
    report({ status: 'online' })
    report({ status: 'offline', error: 'fetch failed' })
    report({ status: 'offline', error: 'fetch failed' })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(bases, [first])
    report({ status: 'offline', error: 'ECONNREFUSED' })
    const moved = Date.now() + 1000
    while (bases.length < 2 && Date.now() < moved) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(bases.length, 2)
    assert.notEqual(new URL(bases[1]).hostname, new URL(first).hostname)
  } finally {
    await runtime.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime reports offline without spawning when the fleet directory is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-unavailable-'))
  let spawned = false
  const reports = []
  const runtime = createFleetRuntime({
    userData: dir,
    port: 9,
    header: 'cd'.repeat(32),
    version: '5.7.53',
    identityImpl: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    fetchImpl: async () => { throw new Error('down') },
    onStatus (status) { reports.push(status) },
    createAgent () {
      spawned = true
      return { start () {}, async stop () {} }
    }
  })
  runtime.start()
  try {
    const deadline = Date.now() + 1000
    while (reports.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(reports[0], { status: 'offline', error: 'Fleet directory unavailable' })
    assert.equal(spawned, false)
  } finally {
    await runtime.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
