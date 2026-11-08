const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createAegisService } = require('../../app/lib/aegis-service')

function fixture (root) {
  const calls = []
  let latest = null
  const runner = {
    validatePaths: payload => calls.push(['validate', payload]),
    start: payload => {
      calls.push(['start', payload])
      latest = { runId: 'a'.repeat(32), state: 'running', findings: [] }
      return latest
    },
    latest: () => latest,
    get: () => latest,
    cancel: () => { latest.state = 'cancelled'; return latest },
    dispose: () => {},
    result: value => { latest = value }
  }
  const service = createAegisService({ dataDir: root, runner })
  return { service, runner, calls }
}

test('Aegis persists installation defaults once and revision-checks target-side settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-settings-'))
  try {
    const { service, calls } = fixture(root)
    const initial = service.handle('settings', {})
    assert.match(initial.jsModulePath, /cve-scanner-js$/)
    assert.match(initial.pythonModulePath, /cve-scanner-py$/)
    assert.equal(initial.revision, 0)
    assert.equal(fs.existsSync(path.join(root, 'settings.json')), true)
    const next = { ...initial, jsModulePath: path.join(root, 'Modules', 'new-js') }
    assert.equal(service.handle('configure', next).revision, 1)
    assert.equal(calls[0][0], 'validate')
    assert.throws(() => service.handle('configure', next), { code: 'STALE_REF' })
    assert.equal(fixture(root).service.handle('settings', {}).jsModulePath, next.jsModulePath)
    assert.throws(() => service.handle('start', initial), { code: 'INVALID_REQUEST' })
    assert.throws(() => service.handle('start', { confirmed: false }), { code: 'INVALID_REQUEST' })
    service.handle('start', { confirmed: true })
    assert.deepEqual(calls.at(-1), ['start', { jsModulePath: next.jsModulePath, pythonModulePath: next.pythonModulePath }])
    assert.throws(() => service.handle('configure', { ...next, revision: 1 }), { code: 'BUSY' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Aegis pages full findings without losing stored data and validates cursors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pages-'))
  try {
    const { service, runner } = fixture(root)
    const runId = 'a'.repeat(32)
    runner.result({ runId, state: 'done', findings: Array.from({ length: 205 }, (_, i) => ({ id: 'CVE-2026-' + (1000 + i) })) })
    const first = service.handle('latest', {})
    assert.equal(first.findings.length, 100)
    assert.equal(first.totalFindings, 205)
    assert.equal(first.nextOffset, 100)
    assert.equal(service.handle('get', { runId, offset: 200, limit: 100 }).findings.length, 5)
    assert.equal(service.handle('get', { runId, offset: 200, limit: 100 }).nextOffset, null)
    for (const payload of [{ runId, offset: -1 }, { runId, limit: 101 }, { runId, command: 'cmd' }, { runId: '../settings' }]) {
      assert.throws(() => service.handle('get', payload), { code: 'INVALID_REQUEST' })
    }
    assert.equal(runner.latest().findings.length, 205)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('corrupt Aegis settings never reset the installation configuration silently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-corrupt-'))
  try {
    fs.writeFileSync(path.join(root, 'settings.json'), '{broken')
    const diagnostics = []
    const service = createAegisService({ dataDir: root, onError: message => diagnostics.push(message) })
    assert.throws(() => service.handle('settings', {}), { code: 'INTERNAL' })
    assert.throws(() => service.handle('start', { confirmed: true }), { code: 'INTERNAL' })
    assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{broken')
    assert.equal(diagnostics.length, 1)
    service.dispose()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
