const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHandlers } = require('../../app/lib/browser-api/command-handlers')
const { createPolicyEngine, DEFAULT_POLICY } = require('../../app/lib/browser-api/policy-engine')
const registry = require('../../app/lib/browser-api/registry.json')

function fixture (cookies) {
  const policy = createPolicyEngine()
  const driver = {
    engine: 'chrome',
    listBrowsers: () => [{ browserId: 'b_12345678', profileId: 'source', profileMode: 'dedicated' }],
    cookies: async id => { assert.equal(id, 'b_12345678'); return cookies }
  }
  const handlers = createHandlers({ policy })
  return () => handlers['site.domains']({ driver, browserId: 'b_12345678' })
}

test('domain inventory excludes all cookie material, deduplicates and binds the profile', async () => {
  const result = await fixture([
    { domain: '.GitHub.com', name: 'sensitive-name', value: 'secret-canary', path: '/private', expires: -1 },
    { domain: 'github.com', name: 'other', value: 'other-secret' },
    { domain: 'developer.mozilla.org', expires: Date.now() / 1000 + 1000 }
  ])()
  assert.deepEqual(result, { browserId: 'b_12345678', engine: 'chrome', profileId: 'source', profileMode: 'dedicated', domains: ['developer.mozilla.org', 'github.com'], excludedCount: 0 })
  assert(!JSON.stringify(result).includes('secret'))
  assert(!JSON.stringify(result).includes('/private'))
})

test('expired, private, IP and malformed cookie domains are not candidates', async () => {
  const result = await fixture([
    { domain: 'expired.test', expires: 1 }, { domain: 'localhost' }, { domain: '127.0.0.1' },
    { domain: 'a.internal' }, { domain: 'bad.test/path' }, { domain: 'a.local' }, { domain: 'valid.test' }
  ])()
  assert.deepEqual(result.domains, ['valid.test'])
  assert.equal(result.excludedCount, 6)
})

test('inventory overflow fails rather than silently returning an incomplete list', async () => {
  await assert.rejects(fixture(Array.from({ length: 1001 }, (_, i) => ({ domain: 'site' + i + '.test' })))(), { code: 'LIMIT_EXCEEDED' })
})

test('domains require sensitive-command approval; remote cookie secret blocks are unchanged', () => {
  const def = registry.commands.find(command => command.name === 'site.domains')
  assert.equal(def.scope, 'browserId')
  assert.equal(def.risk, 'sensitive')
  assert.equal(createPolicyEngine().evaluate({ command: def.name, role: 'agent', risk: def.risk }).effect, 'confirm')
  const old = structuredClone(DEFAULT_POLICY)
  old.roles.agent.rules = [{ command: '*', effect: 'allow' }]
  assert.equal(createPolicyEngine({ policy: old }).evaluate({ command: def.name, role: 'agent', risk: def.risk }).effect, 'deny')
  for (const command of ['cookies.export', 'cookies.import']) assert.equal(createPolicyEngine().evaluate({ command, role: 'agent', risk: 'sensitive' }).effect, 'deny')
})
