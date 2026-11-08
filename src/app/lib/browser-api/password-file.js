const crypto = require('node:crypto')
const { promisify } = require('node:util')
const { apiError } = require('./errors')
const { validateCsvHeader } = require('../passwords-csv')

const derive = promisify(crypto.scrypt)
const FORMAT = 'anubis-passwords-v1'
const MAX_BYTES = 2 * 1024 * 1024
const fail = () => apiError('INVALID_REQUEST', 'Password file could not be decrypted or validated')

function checkPassphrase (value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw apiError('INVALID_REQUEST', 'Use a file passphrase of 12 to 256 characters')
}

function checkCsv (value) {
  if (!Buffer.isBuffer(value) || !value.length || value.length > MAX_BYTES ||
      value.includes(0) || !validateCsvHeader(value.subarray(0, 512).toString('utf8').split(/\r?\n/)[0])) throw fail()
}

async function encryptPasswordFile (plain, password) {
  checkPassphrase(password)
  checkCsv(plain)
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = await derive(password, salt, 32)
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(FORMAT))
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    return { format: FORMAT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  } finally { key.fill(0) }
}

async function decryptPasswordFile (artifact, password) {
  checkPassphrase(password)
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.format !== FORMAT ||
      Object.keys(artifact).some(name => !['format', 'salt', 'iv', 'tag', 'data'].includes(name))) throw fail()
  const decode = (name, length) => {
    const text = artifact[name]
    if (typeof text !== 'string' || text.length > 3 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw fail()
    const value = Buffer.from(text, 'base64')
    if ((length && value.length !== length) || value.length > MAX_BYTES) throw fail()
    return value
  }
  const salt = decode('salt', 16)
  const iv = decode('iv', 12)
  const tag = decode('tag', 16)
  const data = decode('data')
  const key = await derive(password, salt, 32)
  let plain
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(FORMAT))
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(data), decipher.final()])
    checkCsv(plain)
    return plain
  } catch {
    if (plain) plain.fill(0)
    throw fail()
  } finally { key.fill(0) }
}

module.exports = { encryptPasswordFile, decryptPasswordFile, checkPassphrase, MAX_BYTES }
