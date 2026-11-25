const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { createModuleBroker } = require('../../app/lib/module-broker')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')

const brokerRoot = path.resolve(__dirname, '../../../../../anubis-broker')

test('module bridge: no local configuration does not start a process or pretend to be ready', async () => {
  const bridge = createModuleBroker({ spawnProcess: () => { throw new Error('must not spawn') } })
  const status = await bridge.status()
  assert.equal(status.configured, false)
  assert.equal(status.ready, false)
  await assert.rejects(bridge.modules(), { code: 'E_BROKER_NOT_CONFIGURED' })
  await bridge.dispose()
  await assert.rejects(bridge.jobs(), { code: 'E_BROKER_UNAVAILABLE' })
})

test('module bridge: configuration errors and invalid job IDs are explicit', async () => {
  const bridge = createModuleBroker({ configurationError: 'Local service config is corrupt' })
  await assert.rejects(bridge.status(), { code: 'E_BROKER_CONFIG' })
  assert.throws(() => bridge.result('../secret'), { code: 'E_BAD_REQUEST' })
  assert.throws(() => bridge.createJob({ moduleId: 'cve-scanner', input: {}, nodePath: 'bad' }), { code: 'E_BAD_REQUEST' })
  const invalid = createModuleBroker({ service: { nodePath: 'relative' } })
  await assert.rejects(invalid.modules(), { code: 'E_BROKER_CONFIG' })
})

test('module bridge: startup failures, timeout, malformed responses, disconnect and early disposal', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-main-lifecycle-'))
  const fixture = path.join(__dirname, 'fixtures', 'module-broker-service.cjs')
  try {
    for (const [mode, code] of [
      ['exit', 'E_BROKER_UNAVAILABLE'],
      ['timeout', 'E_BROKER_TIMEOUT'],
      ['bad-ready', 'E_BROKER_PROTOCOL'],
      ['bad-json', 'E_BROKER_PROTOCOL'],
      ['disconnect', 'E_BROKER_UNAVAILABLE'],
      ['dispose', 'E_BROKER_UNAVAILABLE']
    ]) {
      const config = path.join(root, mode + '.json')
      fs.writeFileSync(config, JSON.stringify({ mode: mode === 'dispose' ? 'timeout' : mode }))
      const children = []
      const exits = []
      const bridge = createModuleBroker({
        service: { nodePath: process.execPath, entryPath: fixture, configPath: config },
        timeoutMs: 300,
        spawnProcess: (...args) => {
          const child = spawn(...args)
          children.push(child)
          exits.push(once(child, 'exit'))
          return child
        }
      })
      try {
        if (mode === 'disconnect') {
          await bridge.status()
          await assert.rejects(bridge.jobs(), { code })
        } else {
          const request = bridge.status()
          const rejection = assert.rejects(request, { code })
          if (mode === 'dispose') await bridge.dispose()
          await rejection
        }
      } finally {
        await Promise.all([bridge.dispose(), bridge.dispose()])
        await Promise.all(exits)
      }
      assert.equal(children.length, 1)
      assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null))
      await assert.rejects(bridge.status(), { code: 'E_BROKER_UNAVAILABLE' })
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Hub modules: calls only the Broker facade and never exposes a connection secret', async () => {
  const seen = []
  const bridge = {
    status: () => ({ configured: true, ready: true }),
    modules: () => ({ modules: [] }),
    jobs: () => ({ jobs: [] }),
    createJob: request => { seen.push(request); return { job: { jobId: 'a'.repeat(32) } } },
    getJob: id => ({ job: { jobId: id } }),
    result: id => ({ result: { status: 'partial', data: { id } } }),
    cancel: id => ({ job: { jobId: id, state: 'cancelled' } })
  }
  const controller = createBrowserHubController({ api: {}, tokens: {}, moduleBroker: bridge })
  assert.equal((await controller.handle('modules.status')).result.ready, true)
  assert.deepEqual((await controller.handle('modules.list')).result, { modules: [] })
  assert.deepEqual((await controller.handle('modules.jobs')).result, { jobs: [] })
  const input = { moduleId: 'cve-scanner', input: {} }
  assert.equal((await controller.handle('modules.createJob', input)).ok, true)
  assert.deepEqual(seen, [input])
  const jobId = 'a'.repeat(32)
  assert.equal((await controller.handle('modules.getJob', { jobId })).result.job.jobId, jobId)
  assert.equal((await controller.handle('modules.result', { jobId })).result.result.status, 'partial')
  assert.equal((await controller.handle('modules.cancel', { jobId })).result.job.state, 'cancelled')
  assert.equal((await controller.handle('modules.result', null)).ok, false)
})

test('Hub modules stay disabled when no Broker is configured', async () => {
  const controller = createBrowserHubController({ api: {}, tokens: {} })
  try {
    assert.deepEqual((await controller.handle('modules.status')).result, {
      configured: false,
      ready: false,
      executionEnabled: false
    })
    for (const action of ['modules.list', 'modules.jobs', 'modules.createJob', 'modules.getJob', 'modules.result', 'modules.cancel']) {
      const result = await controller.handle(action, { jobId: 'a'.repeat(32) })
      assert.equal(result.ok, false, action)
      assert.equal(result.error.code, 'DISABLED', action)
    }
  } finally {
    controller.dispose()
  }
})

test('module bridge: actual separate Broker HTTP auth, execution gate, result and shutdown', {
  skip: !fs.existsSync(path.join(brokerRoot, 'src', 'cli.js')),
  timeout: 30000
}, async () => {
  const { sha256Tree } = require(path.join(brokerRoot, 'src', 'registry'))
  for (const allow of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-main-broker-'))
    let bridge
    try {
      const modules = path.join(root, 'modules')
      const mod = path.join(modules, 'echo-module')
      fs.cpSync(path.join(brokerRoot, 'examples', 'echo-module'), mod, { recursive: true })
      const config = path.join(root, 'broker.json')
      fs.writeFileSync(config, JSON.stringify({
        dataDir: path.join(root, 'data'),
        modulesDirs: [modules],
        bundlePins: { 'echo-module': sha256Tree(mod) },
        allowUnisolatedModules: allow
      }))
      bridge = createModuleBroker({ service: { nodePath: process.execPath, entryPath: path.join(brokerRoot, 'src', 'cli.js'), configPath: config } })
      const [status, catalog] = await Promise.all([bridge.status(), bridge.modules()])
      assert.equal(status.ready, true)
      assert.equal(status.executionEnabled, allow)
      assert.equal(status.isolation.network, 'not-enforced')
      assert.equal(catalog.modules[0].bundlePinned, true)
      assert.ok(!JSON.stringify(status).includes('token'))
      const payload = { moduleId: 'echo-module', input: { message: 'main bridge', steps: 0 } }
      if (!allow) await assert.rejects(bridge.createJob(payload), { code: 'E_EXECUTION_DISABLED' })
      else {
        const { job } = await bridge.createJob(payload)
        const deadline = Date.now() + 10000
        let current
        do {
          current = (await bridge.getJob(job.jobId)).job
          if (current.state === 'done' || current.state === 'failed') break
          await new Promise(resolve => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        assert.equal(current.state, 'done', JSON.stringify(current))
        assert.equal((await bridge.result(job.jobId)).result.data.echo, 'main bridge')
        assert.equal((await bridge.jobs()).jobs.length, 1)
        const slow = await bridge.createJob({ moduleId: 'echo-module', input: { message: 'cancel', sleepMs: 2000, steps: 10 } })
        await bridge.cancel(slow.job.jobId)
      }
    } finally {
      if (bridge) await bridge.dispose()
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
