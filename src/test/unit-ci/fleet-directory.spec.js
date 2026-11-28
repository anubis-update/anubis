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

const DEVICE = '11111111-1111-4111-8111-111111111111'

function runtimeFor (dir, { failuresBeforeSwitch = 3, fetchImpl, createAgent, onStatus = () => {} } = {}) {
  return createFleetRuntime({
    userData: dir,
    port: 9,
    header: 'ab'.repeat(32),
    version: '5.7.58',
    failuresBeforeSwitch,
    identityImpl: () => ({ id: DEVICE }),
    fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => document })),
    onStatus,
    createAgent: createAgent || (() => ({ start () {}, stop () {} }))
  })
}

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

async function until (predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return
    await settled()
  }
  assert.fail('condition was not met')
}

test('only repeated transport failures change gateway; auth and policy errors stay put', () => {
  for (const error of [
    'Enrollment rejected: HTTP 408',
    'Enrollment rejected: HTTP 429',
    'Enrollment rejected: HTTP 503',
    'fetch failed',
    'connect ECONNRESET',
    'getaddrinfo ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'certificate has expired',
    'tunnel disconnected',
    'tunnel failed',
    'channel connection failed'
  ]) {
    assert.equal(fleet.isTransportFailure({ status: 'offline', error }), true, error)
  }
  for (const error of [
    'Enrollment rejected: HTTP 401',
    'Enrollment rejected: HTTP 403',
    'Enrollment rejected: HTTP 400',
    'policy denied'
  ]) {
    assert.equal(fleet.isTransportFailure({ status: 'offline', error }), false, error)
  }
  assert.equal(fleet.isTransportFailure({ status: 'online', error: 'fetch failed' }), false)
  assert.equal(fleet.isTransportFailure({ status: 'offline' }), false)
  assert.equal(fleet.isTransportFailure(null), false)
})

test('the assigned gateway is held until three transport failures, and an online probe clears the count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-hold-'))
  const agents = []
  const runtime = runtimeFor(dir, {
    createAgent ({ baseUrl, onStatus }) {
      const agent = { baseUrl, onStatus, stopped: false, start () { agents.push(agent) }, stop () { agent.stopped = true } }
      return agent
    }
  })
  runtime.start()
  try {
    await until(() => agents.length === 1)
    const first = agents[0]
    first.onStatus({ status: 'offline', error: 'Enrollment rejected: HTTP 401' })
    first.onStatus({ status: 'offline', error: 'fetch failed' })
    first.onStatus({ status: 'offline', error: 'connect ECONNRESET' })
    await settled()
    assert.equal(agents.length, 1)
    first.onStatus({ status: 'online' })
    first.onStatus({ status: 'offline', error: 'ETIMEDOUT' })
    first.onStatus({ status: 'offline', error: 'certificate has expired' })
    await settled()
    assert.equal(agents.length, 1)
    first.onStatus({ status: 'offline', error: 'tunnel disconnected' })
    await until(() => agents.length === 2)
    const assigned = fleet.readState(fleet.statePath(dir))
    const gateway = assigned.fleet.gateways.find(item => item.id === assigned.gatewayId)
    assert.equal(first.stopped, true)
    assert.equal(new URL(first.baseUrl).hostname, gateway.primary)
    assert.equal(new URL(agents[1].baseUrl).hostname, gateway.backup)
  } finally {
    await runtime.stop()
  }
})

test('exhausting primary and backup persists the other gateway', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-move-'))
  const agents = []
  const runtime = runtimeFor(dir, {
    failuresBeforeSwitch: 1,
    createAgent ({ baseUrl, onStatus }) {
      const agent = { baseUrl, onStatus, start () { agents.push(agent) }, stop () {} }
      return agent
    }
  })
  runtime.start()
  try {
    await until(() => agents.length === 1)
    const initial = fleet.readState(fleet.statePath(dir))
    const initialGateway = initial.fleet.gateways.find(item => item.id === initial.gatewayId)
    agents[0].onStatus({ status: 'offline', error: 'fetch failed' })
    await until(() => agents.length === 2)
    assert.equal(new URL(agents[1].baseUrl).hostname, initialGateway.backup)
    agents[1].onStatus({ status: 'offline', error: 'ENOTFOUND' })
    await until(() => agents.length === 3)
    const moved = fleet.readState(fleet.statePath(dir))
    assert.notEqual(moved.gatewayId, initial.gatewayId)
    const next = moved.fleet.gateways.find(item => item.id === moved.gatewayId)
    assert.equal(new URL(agents[2].baseUrl).hostname, next.primary)
  } finally {
    await runtime.stop()
  }
})

test('startup stays offline when the directory cannot be fetched and nothing is saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-fleet-offline-'))
  let seen
  const runtime = runtimeFor(dir, {
    fetchImpl: async () => { throw new Error('down') },
    onStatus (status) { seen = status },
    createAgent () { throw new Error('must not connect without an assignment') }
  })
  runtime.start()
  try {
    await until(() => seen)
    assert.equal(seen.status, 'offline')
    assert.equal(seen.error, 'Fleet directory unavailable')
    await assert.rejects(runtime.activate('key'), /Fleet gateway is not connected/)
  } finally {
    await runtime.stop()
  }
})
