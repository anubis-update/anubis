const crypto = require('crypto')
const path = require('path')
const { createFleetRuntime } = require('./fleet-runtime')

function createManagedRuntime ({
  createAgent,
  userData,
  port,
  header,
  version,
  env = process.env,
  onStatus,
  identityImpl,
  fetchImpl,
  browserEnrollment,
  onBrowserEnrolled
}) {
  if (!env.ANUBIS_ADMIN_MANAGED_URL) {
    return createFleetRuntime({
      createAgent, userData, port, header, version, onStatus, identityImpl, fetchImpl, browserEnrollment, onBrowserEnrolled
    })
  }
  const baseUrl = env.ANUBIS_ADMIN_MANAGED_URL
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Managed connectivity requires HTTPS (except loopback tests)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid managed connectivity server URL')
  }
  const agent = createAgent({
    baseUrl: url.href.replace(/\/$/, ''),
    identityFile: path.join(userData, 'managed-access-identity.json'),
    label: require('os').hostname(),
    app: 'anubis-desktop',
    version,
    machineGuid: require('./client-inventory').machineGuid(),
    onIdentityAdopted: value => require('./browser-auto-enroll').rememberInstallationIdentity(userData, value),
    getInventory: () => require('./client-inventory').getManagedInventory(),
    localHost: '127.0.0.1',
    localPort: port,
    localHeaders: { 'x-anubis-managed-transport': header },
    browserEnrollment,
    onBrowserEnrolled,
    probe: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/run`, {
        signal: AbortSignal.timeout(5000)
      })
      return response.ok && await response.text() === 'ok'
    },
    onStatus
  })
  return agent
}

function createTransportSecret () {
  return crypto.randomBytes(32).toString('hex')
}

module.exports = { createManagedRuntime, createTransportSecret }
