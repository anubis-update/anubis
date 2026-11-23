const { test } = require('node:test')
const assert = require('node:assert/strict')
const U = require('../../app/lib/browser-api/control-channel-util')

test('control-channel signatures cover every field except the signature itself', () => {
  const frame = { z: 1, sig: 'not-part-of-the-payload', n: 2, nested: { sig: 'kept' } }
  const payload = U.frameForSig(frame)
  assert.equal(payload, U.canonical({ z: 1, n: 2, nested: { sig: 'kept' } }))
  const keys = U.generateKeyPair()
  const signature = U.sign(keys.privateKey, payload)
  assert.equal(U.verify(keys.publicKey, payload, signature), true)
  assert.equal(U.verify(keys.publicKey, U.canonical(frame), signature), false)
  assert.equal(U.frameForSig({ sig: 'only' }), U.canonical({}))
})
