'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const U = require('../../app/lib/browser-api/control-channel-util')

test('signed control frames exclude the signature and leave the original frame intact', () => {
  const frame = { type: 'command', seq: 2, sig: 'keep-me', extra: undefined }
  const payload = U.frameForSig(frame)
  assert.equal(frame.sig, 'keep-me')
  assert.equal(payload, '{"seq":2,"type":"command"}')
  const keys = U.generateKeyPair()
  const sig = U.sign(keys.privateKey, payload)
  assert.equal(U.verify(keys.publicKey, U.frameForSig({ ...frame, sig }), sig), true)
  assert.equal(U.verify(keys.publicKey, U.canonical({ ...frame, sig }), sig), false)
})
