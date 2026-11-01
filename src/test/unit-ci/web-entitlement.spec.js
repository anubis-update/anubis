const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  ENTITLEMENT_ROUTE,
  ACTIVATE_ROUTE,
  ACTIVATION_MESSAGES,
  parseEntitlement,
  parseActivation,
  activationMessage
} = require('../../client/components/web/web-entitlement')

test('routes are the shipped same-origin gateway endpoints', () => {
  assert.equal(ENTITLEMENT_ROUTE, '/_anubis/browser-entitlement')
  assert.equal(ACTIVATE_ROUTE, '/_anubis/browser-activate')
})

test('parseEntitlement reads an entitled device with a real proExpiresAt', () => {
  assert.deepEqual(parseEntitlement({ entitled: true, proExpiresAt: 4947129828013 }), {
    entitled: true,
    proExpiresAt: 4947129828013
  })
})

test('parseEntitlement keeps null proExpiresAt for grandfathered devices', () => {
  assert.deepEqual(parseEntitlement({ entitled: true, proExpiresAt: null }), {
    entitled: true,
    proExpiresAt: null
  })
})

test('parseEntitlement is fail-closed on false, missing or malformed payloads', () => {
  assert.deepEqual(parseEntitlement({ entitled: false }), { entitled: false, proExpiresAt: null })
  assert.deepEqual(parseEntitlement(null), { entitled: false, proExpiresAt: null })
  assert.deepEqual(parseEntitlement(undefined), { entitled: false, proExpiresAt: null })
  assert.deepEqual(parseEntitlement({}), { entitled: false, proExpiresAt: null })
  // Only a strict boolean true entitles; truthy strings must not unlock.
  assert.deepEqual(parseEntitlement({ entitled: 'true' }), { entitled: false, proExpiresAt: null })
  assert.deepEqual(parseEntitlement({ entitled: true, proExpiresAt: '5' }), { entitled: true, proExpiresAt: null })
})

test('parseActivation unlocks on a 200 with entitled:true', () => {
  assert.deepEqual(parseActivation(200, { entitled: true, proExpiresAt: 4947129828013 }), {
    ok: true,
    entitled: true,
    proExpiresAt: 4947129828013,
    error: null
  })
})

test('parseActivation stays locked and surfaces the gateway error code on 403', () => {
  for (const error of ['invalid', 'scope', 'expired']) {
    assert.deepEqual(parseActivation(403, { entitled: false, error }), {
      ok: false,
      entitled: false,
      proExpiresAt: null,
      error
    })
  }
})

test('parseActivation falls back to invalid on 200 without entitlement or missing code', () => {
  assert.deepEqual(parseActivation(200, { entitled: false }), {
    ok: false,
    entitled: false,
    proExpiresAt: null,
    error: 'invalid'
  })
  assert.deepEqual(parseActivation(403, null), {
    ok: false,
    entitled: false,
    proExpiresAt: null,
    error: 'invalid'
  })
  assert.deepEqual(parseActivation(400, { error: 'An activation key is required' }), {
    ok: false,
    entitled: false,
    proExpiresAt: null,
    error: 'An activation key is required'
  })
})

test('activationMessage maps known codes and falls back neutrally', () => {
  assert.equal(activationMessage('invalid'), ACTIVATION_MESSAGES.invalid)
  assert.equal(activationMessage('scope'), ACTIVATION_MESSAGES.scope)
  assert.equal(activationMessage('expired'), ACTIVATION_MESSAGES.expired)
  assert.equal(activationMessage('offline'), ACTIVATION_MESSAGES.offline)
  assert.equal(activationMessage('nonsense'), 'Activation failed')
})
