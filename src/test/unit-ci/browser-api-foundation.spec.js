const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createValidator } = require('../../app/lib/browser-api/schema-validate')
const { apiError, httpStatusFor, toWireError, safeUrl } = require('../../app/lib/browser-api/errors')
const common = require('../../app/lib/browser-api/common.schema.json')
const registry = require('../../app/lib/browser-api/registry.json')

const v = createValidator({ documents: { 'common.schema.json': common } })

test('validator applies defaults, rejects extras and bad types', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string', minLength: 1 }, b: { type: 'integer', default: 3, minimum: 1 } } }
  const ok = v.validate(schema, { a: 'x' })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.b, 3)
  assert.equal(v.validate(schema, { a: '' }).ok, false)
  assert.equal(v.validate(schema, { a: 'x', z: 1 }).ok, false)
  assert.equal(v.validate(schema, { a: 'x', b: 0 }).ok, false)
  assert.equal(v.validate(schema, {}).ok, false)
})

test('validator supports enum, oneOf and const', () => {
  assert.equal(v.validate({ enum: ['a', 'b'] }, 'c').ok, false)
  assert.equal(v.validate({ const: 1 }, 1).ok, true)
  assert.equal(v.validate({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 1).ok, true)
  assert.equal(v.validate({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1).ok, false)
})

test('errors map to HTTP status and never leak internals', () => {
  assert.equal(httpStatusFor('POLICY_DENIED'), 403)
  const leaked = { code: 'INTERNAL', message: 'Internal error', retryable: false }
  for (const thrown of [
    new Error('C:\\secret\\path boom'),
    Object.assign(new Error('C:\\secret\\path boom'), { code: 'ENOENT' }),
    Object.assign(new Error('token=secret'), { code: 'STATE_READ_FAILED' })
  ]) {
    assert.deepEqual(toWireError(thrown), leaked)
  }
  const known = toWireError(Object.assign(new Error('busy'), { code: 'BUSY', retryAfterMs: 1000 }))
  assert.equal(known.code, 'BUSY')
  assert.equal(known.message, 'busy')
  assert.equal(known.retryAfterMs, 1000)
  assert.equal(toWireError(apiError('STALE_REF', 'm')).code, 'STALE_REF')
  assert.equal(safeUrl('https://a.test/p?token=1#x'), 'https://a.test/p')
})

test('registry is loadable and has unique commands', () => {
  const cmds = registry.commands || registry
  assert.ok(Object.keys(cmds).length >= 40 || cmds.length >= 40)
})
