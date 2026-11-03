const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createPasswordVault, validateCsvHeader, encryptBuffer, decryptBuffer } = require('../../app/lib/passwords-csv')

const key = crypto.randomBytes(32)

function memFs (files) {
  return {
    statSync: (p) => ({ isFile: () => p in files, size: (files[p] || Buffer.alloc(0)).length }),
    openSync: (p) => p,
    readSync: (fd, buf, o, l, pos) => files[fd].copy(buf, o, pos, pos + l),
    closeSync () {},
    readFileSync: (p) => Buffer.from(files[p]),
    writeFileSync: (p, d) => { files[p] = Buffer.from(d) },
    unlinkSync: (p) => { delete files[p] }
  }
}

test('header validation', () => {
  assert.equal(validateCsvHeader('name,url,username,password,note'), true)
  assert.equal(validateCsvHeader('\uFEFF"url","username","password"'), true)
  assert.equal(validateCsvHeader('a,b,c'), false)
})

test('encrypt/decrypt round trip, tamper and wrong key fail', () => {
  const blob = encryptBuffer(Buffer.from('secret'), key)
  assert.ok(!blob.includes(Buffer.from('secret')))
  assert.equal(decryptBuffer(blob, key).toString(), 'secret')
  blob[blob.length - 1] ^= 1
  assert.throws(() => decryptBuffer(blob, key))
  assert.throws(() => decryptBuffer(encryptBuffer(Buffer.from('x'), key), crypto.randomBytes(32)))
  assert.throws(() => encryptBuffer(Buffer.from('x'), Buffer.alloc(5)), TypeError)
})

test('inspectStaged validates the header and never returns contents', () => {
  const files = { good: Buffer.from('name,url,username,password\nx,https://a.test,u,SECRETPW\n'), bad: Buffer.from('foo,bar\n1,2\n') }
  const v = createPasswordVault({ key, fsApi: memFs(files) })
  const r = v.inspectStaged('good')
  assert.deepEqual(Object.keys(r), ['bytes'])
  assert.throws(() => v.inspectStaged('bad'), (e) => e.code === 'INVALID_REQUEST')
  assert.throws(() => v.inspectStaged('missing'), (e) => e.code === 'INVALID_REQUEST')
})

test('sealFile encrypts and removes the plaintext', () => {
  const files = { 'p.csv': Buffer.from('name,url,username,password\nx,y,z,PW-MARKER-123\n') }
  const v = createPasswordVault({ key, fsApi: memFs(files) })
  assert.deepEqual(v.sealFile('p.csv', 'p.enc'), { sealed: true })
  assert.equal('p.csv' in files, false)
  assert.ok(!files['p.enc'].includes(Buffer.from('PW-MARKER-123')))
  assert.match(decryptBuffer(files['p.enc'], key).toString(), /PW-MARKER-123/)
})
