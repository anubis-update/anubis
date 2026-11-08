'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_DIRECTORY = Object.freeze([
  'https://devices.anubis.locker/fleet.json',
  'https://raw.githubusercontent.com/anubis-cloud/fleet-config/main/fleet.json'
])

function hostname (value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9.-]+$/.test(value)) return
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) return
  return value
}

function validate (doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Invalid fleet document')
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) throw new Error('Invalid fleet revision')
  if (!Array.isArray(doc.directory) || doc.directory.length < 1 || doc.directory.length > 8) {
    throw new Error('Invalid fleet directory')
  }
  const directory = doc.directory.map(value => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid fleet directory URL')
    }
    return url.href
  })
  if (!Array.isArray(doc.gateways) || doc.gateways.length < 1 || doc.gateways.length > 32) {
    throw new Error('Invalid fleet gateways')
  }
  const gateways = doc.gateways.map(gateway => {
    const primary = hostname(gateway?.primary)
    const backup = hostname(gateway?.backup)
    if (!/^[a-z0-9-]{1,32}$/.test(gateway?.id || '') || !primary || !backup || primary === backup) {
      throw new Error('Invalid fleet gateway')
    }
    if (!Number.isSafeInteger(gateway.weight) || gateway.weight < 1 || gateway.weight > 100) {
      throw new Error('Invalid fleet weight')
    }
    return { id: gateway.id, primary, backup, weight: gateway.weight }
  })
  if (new Set(gateways.map(gateway => gateway.id)).size !== gateways.length) throw new Error('Duplicate fleet gateway')
  return { revision: doc.revision, directory, gateways }
}

function score (deviceId, gatewayId) {
  return crypto.createHash('sha256').update(`${deviceId}\0${gatewayId}`).digest()
}

function chooseGateway (deviceId, gateways, excluded = new Set()) {
  const available = gateways.filter(gateway => !excluded.has(gateway.id))
  const pool = available.length ? available : gateways
  let best = pool[0]
  let bestScore = null
  for (const gateway of pool) {
    let local = score(deviceId, gateway.id)
    for (let index = 1; index < gateway.weight; index++) {
      const extra = score(deviceId, `${gateway.id}#${index}`)
      if (Buffer.compare(extra, local) > 0) local = extra
    }
    if (!bestScore || Buffer.compare(local, bestScore) > 0) {
      best = gateway
      bestScore = local
    }
  }
  return best
}

function endpoints (gateway) {
  return [`https://${gateway.primary}/`, `https://${gateway.backup}/`]
}

function readState (file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const fleet = validate(raw.fleet)
    if (raw.gatewayId && !fleet.gateways.some(gateway => gateway.id === raw.gatewayId)) return { fleet }
    return { fleet, gatewayId: raw.gatewayId }
  } catch {
    return null
  }
}

function writeState (file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = file + '.tmp'
  fs.writeFileSync(next, JSON.stringify({ fleet: state.fleet, gatewayId: state.gatewayId }))
  fs.renameSync(next, file)
}

async function fetchFleet (fetchImpl, directory) {
  let last
  for (const url of directory) {
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('Fleet directory HTTP ' + response.status)
      return validate(await response.json())
    } catch (error) {
      last = error
    }
  }
  throw last || new Error('Fleet directory unavailable')
}

function resolveAssignment ({ deviceId, previous, fetched }) {
  const fleet = fetched && (!previous || fetched.revision >= previous.fleet.revision) ? fetched : previous.fleet
  const known = fleet.gateways.some(gateway => gateway.id === previous?.gatewayId)
  const gatewayId = known ? previous.gatewayId : chooseGateway(deviceId, fleet.gateways).id
  return { fleet, gatewayId }
}

function isTransportFailure (status) {
  if (!status || status.status !== 'offline' || typeof status.error !== 'string') return false
  return /Enrollment rejected: HTTP (?:408|429|5\d\d)|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|tunnel disconnected|tunnel failed|channel connection failed/i.test(status.error)
}

module.exports = {
  DEFAULT_DIRECTORY,
  validate,
  chooseGateway,
  endpoints,
  readState,
  writeState,
  fetchFleet,
  resolveAssignment,
  isTransportFailure,
  statePath: directory => path.join(directory, 'fleet-state.json')
}
