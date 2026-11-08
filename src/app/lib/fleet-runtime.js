'use strict'

const path = require('node:path')
const fleet = require('./fleet-directory')

function createFleetRuntime ({
  createAgent,
  userData,
  port,
  header,
  version,
  onStatus,
  identityImpl = require('@ai-security-tool/managed-access').identity,
  fetchImpl = global.fetch,
  failuresBeforeSwitch = 3,
  browserEnrollment,
  onBrowserEnrolled
}) {
  const stateFile = fleet.statePath(userData)
  const identityFile = path.join(userData, 'managed-access-identity.json')
  let current
  let running = false
  let switching = false
  let endpointIndex = 0
  let failures = 0
  let refreshTimer

  function assignment () {
    return fleet.readState(stateFile)
  }

  function gateway () {
    const state = assignment()
    return state.fleet.gateways.find(item => item.id === state.gatewayId) || state.fleet.gateways[0]
  }

  function spawn () {
    const baseUrl = fleet.endpoints(gateway())[endpointIndex]
    const inventory = require('./client-inventory')
    current = createAgent({
      baseUrl,
      identityFile,
      label: require('node:os').hostname(),
      app: 'anubis-desktop',
      version,
      machineGuid: inventory.machineGuid(),
      onIdentityAdopted: value => require('./browser-auto-enroll').rememberInstallationIdentity(userData, value),
      getInventory: () => require('./client-inventory').getManagedInventory(),
      localHost: '127.0.0.1',
      localPort: port,
      localHeaders: { 'x-anubis-managed-transport': header },
      browserEnrollment,
      onBrowserEnrolled,
      probe: async () => {
        const response = await fetch(`http://127.0.0.1:${port}/run`, { signal: AbortSignal.timeout(5000) })
        return response.ok && await response.text() === 'ok'
      },
      onStatus (status) {
        onStatus(status)
        if (status?.status === 'online') failures = 0
        if (running && !switching && fleet.isTransportFailure(status)) rotate()
      }
    })
    current.start()
  }

  function rotate () {
    if (switching || !running) return
    failures += 1
    if (failures < failuresBeforeSwitch) return
    failures = 0
    switching = true
    setTimeout(() => {
      switchEndpoint().catch(error => onStatus({ status: 'offline', error: error.message }))
    }, 0)
  }

  async function switchEndpoint () {
    if (!running) { switching = false; return }
    const state = assignment()
    const addresses = fleet.endpoints(gateway())
    endpointIndex += 1
    if (endpointIndex >= addresses.length) {
      endpointIndex = 0
      const next = fleet.chooseGateway(identityImpl(identityFile).id, state.fleet.gateways, new Set([state.gatewayId]))
      fleet.writeState(stateFile, { fleet: state.fleet, gatewayId: next.id })
    }
    try { await current?.stop() } catch {}
    switching = false
    if (running) spawn()
  }

  async function refresh () {
    const previous = fleet.readState(stateFile)
    const directory = previous?.fleet.directory || fleet.DEFAULT_DIRECTORY
    let fetched = null
    try { fetched = await fleet.fetchFleet(fetchImpl, directory) } catch {}
    if (!fetched && !previous) throw new Error('Fleet directory unavailable')
    const deviceId = identityImpl(identityFile).id
    const resolved = fleet.resolveAssignment({ deviceId, previous, fetched })
    const moved = previous?.gatewayId && previous.gatewayId !== resolved.gatewayId
    const renamed = previous && JSON.stringify(previous.fleet.gateways) !== JSON.stringify(resolved.fleet.gateways)
    fleet.writeState(stateFile, resolved)
    if (running && (moved || renamed || !current)) {
      switching = true
      endpointIndex = 0
      try { await current?.stop() } catch {}
      switching = false
      if (running) spawn()
    }
  }

  return {
    get id () { return current?.id },
    get fingerprint () { return current?.fingerprint },
    get status () { return current?.status || 'offline' },
    start () {
      if (running) return
      running = true
      refresh().then(() => { if (running && !current) spawn() }).catch(error => {
        onStatus({ status: 'offline', error: error.message })
        refreshTimer = setTimeout(() => { if (running) refresh().then(() => { if (running && !current) spawn() }).catch(() => {}) }, 15000)
        refreshTimer.unref?.()
      })
    },
    async stop () {
      running = false
      clearTimeout(refreshTimer)
      switching = true
      try { await current?.stop() } catch {}
      switching = false
    },
    activate (key) {
      if (!current) return Promise.reject(new Error('Fleet gateway is not connected'))
      return current.activate(key)
    }
  }
}

module.exports = { createFleetRuntime }
