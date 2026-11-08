/**
 * Assembly of the Browser API core (no network, no Electron): registry,
 * policy, audit, redactor, events, leases, confirmations, drivers + dispatcher.
 * Transports (/v1 REST/WS, MCP) take the returned `api` and only call
 * `api.dispatcher.execute(request, actor)`.
 */

const path = require('node:path')
const registryJson = require('./registry.json')
const commonSchema = require('./common.schema.json')
const { createCommandRegistry, createDispatcher } = require('./command-registry')
const { createHandlers } = require('./command-handlers')
const { createPolicyEngine, DEFAULT_POLICY } = require('./policy-engine')
const { createPolicyStore } = require('./policy-store')
const { createRedactor } = require('./redactor')
const { createAuditLog } = require('./audit-log')
const { createIdempotencyCache } = require('./idempotency-cache')
const { createLeaseManager } = require('./lease-manager')
const { createEventBus } = require('./event-bus')
const { createConfirmations } = require('./confirmations')
const { createCdpDriver, createRbiDriver, createDriverHub } = require('../browser-driver')
const { createProfileCatalog } = require('../cdp-profiles')
const { createHistoryReader } = require('../cdp-history')

function createBrowserApi ({
  aegis,
  launchBrowser,
  resolveSourceDir,
  auditDir,
  auditFs,
  deviceInfo = () => ({}),
  policy: policyDoc = DEFAULT_POLICY,
  adminOverlay,
  engines = ['chrome', 'edge'],
  catalogIo = {},
  policyIo,
  staging,
  vault,
  readDevModePolicy,
  extensionStateForHandle,
  historyReader,
  onActiveTarget,
  unattendedRemote = false,
  now = () => Date.now(),
  transport = 'local-rest'
} = {}) {
  const policy = createPolicyEngine({ policy: policyDoc, adminOverlay })
  const policyStore = createPolicyStore({ engine: policy, io: policyIo, adminOverlay })
  const persistedPolicy = policyStore.load()
  if (persistedPolicy) policy.setPolicy(persistedPolicy)
  const redactor = createRedactor(policy.redaction())
  const bus = createEventBus({ redact: (d) => redactor.redact(d).value, now })
  const audit = createAuditLog({ fsApi: auditFs, dir: auditDir || path.join('.', 'browser-audit'), now, retainDays: (policy.audit() || {}).retainDays })
  const leases = createLeaseManager({ now })
  const confirmations = createConfirmations({ emit: bus.emit, now, timeoutSec: (policy.confirmation() || {}).timeoutSec })
  const idempotency = createIdempotencyCache({ now })
  const catalog = createProfileCatalog({ ...catalogIo, resolveSourceDir })
  const history = historyReader || createHistoryReader()

  const drivers = engines.map((engine) => createCdpDriver({
    engine,
    launchBrowser,
    catalog,
    historyReader: history,
    getLimits: () => policy.limits(),
    checkUrl: (url) => policy.checkUrl(url),
    allowExtensions: () => policy.extensions().allowInstall === true,
    resolveSource: (source) => (staging && source.stagedId ? staging.resolveDir(source.stagedId) : null),
    readDevModePolicy,
    extensionStateForHandle,
    onActiveTarget,
    emit: bus.emit
  }))
  drivers.push(createRbiDriver())
  const hub = createDriverHub({ drivers, defaultEngine: engines[0] || 'rbi' })

  const registry = createCommandRegistry({ registry: registryJson, documents: { 'common.schema.json': commonSchema } })
  const handlers = createHandlers({
    aegis,
    hub,
    policy,
    leases,
    staging,
    vault,
    deviceInfo: () => ({ ...deviceInfo(), registry: registry.list() })
  })
  const info = deviceInfo()
  const dispatcher = createDispatcher({
    registry,
    hub,
    handlers,
    policy,
    audit,
    redactor,
    idempotency,
    leases,
    confirmations,
    unattendedRemote,
    deviceId: info.deviceId || 'device',
    transport,
    now
  })

  function sharedLaunchOptions (engine) {
    catalog.enumerate(engine)
    const profileId = catalog.selected(engine)
    const profile = profileId && catalog.resolve(profileId)
    return {
      ...(profile ? { profileId, profileDirectory: profile.dir } : {}),
      unsafeExtensionDebugging: policy.extensions().allowInstall === true
    }
  }

  return { registry, dispatcher, hub, policy, policyStore, staging, audit, events: bus, confirmations, leases, redactor, catalog, sharedLaunchOptions, shutdown: () => hub.shutdown() }
}

module.exports = { createBrowserApi }
