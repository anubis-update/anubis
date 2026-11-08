const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

function brokerError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createModuleBroker ({ service, configurationError, spawnProcess = spawn, log = () => {}, timeoutMs = 15000 } = {}) {
  let child
  let connection
  let starting
  let rejectStart
  let stopping
  let disposed = false
  let lastError = null
  const pending = new Map()
  const unavailable = () => brokerError('E_BROKER_UNAVAILABLE', 'The module Broker is not connected')
  const validateService = () => {
    if (!service || typeof service !== 'object' || Array.isArray(service) ||
        Object.keys(service).some(key => !['nodePath', 'entryPath', 'configPath'].includes(key)) ||
        !['nodePath', 'entryPath', 'configPath'].every(key => typeof service[key] === 'string' && path.isAbsolute(service[key]))) {
      throw brokerError('E_BROKER_CONFIG', 'A locally configured Node executable, Broker entry and config path are required')
    }
    for (const key of ['nodePath', 'entryPath', 'configPath']) {
      if (!fs.statSync(service[key]).isFile()) throw brokerError('E_BROKER_CONFIG', 'Broker service files are unavailable')
    }
  }
  function request (method, route, body) {
    if (!connection) return Promise.reject(unavailable())
    return new Promise((resolve, reject) => {
      const requestFailed = error => reject(error.code?.startsWith('E_') ? error : unavailable())
      const data = body === undefined ? null : JSON.stringify(body)
      const req = http.request({
        host: '127.0.0.1',
        port: connection.port,
        path: '/v1/' + route,
        method,
        headers: {
          authorization: 'Bearer ' + connection.token,
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
        }
      }, res => {
        const chunks = []
        let size = 0
        res.on('data', chunk => {
          size += chunk.length
          if (size > 16 * 1024 * 1024) req.destroy(brokerError('E_RESULT_TOO_LARGE', 'Broker response exceeds 16 MiB'))
          else chunks.push(chunk)
        })
        res.on('error', requestFailed)
        res.on('end', () => {
          let result
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
            reject(brokerError('E_BROKER_PROTOCOL', 'Broker returned an invalid response'))
            return
          }
          if (!result || typeof result !== 'object' || Array.isArray(result)) {
            reject(brokerError('E_BROKER_PROTOCOL', 'Broker returned an invalid response'))
          } else if (res.statusCode !== 200 || result.error) {
            reject(brokerError(result.error?.code || 'E_BROKER_REQUEST', result.error?.message || 'Broker request failed'))
          } else resolve(result)
        })
      })
      pending.set(req, connection)
      req.once('close', () => pending.delete(req))
      req.on('error', requestFailed)
      req.setTimeout(timeoutMs, () => req.destroy(brokerError('E_BROKER_TIMEOUT', 'Broker request timed out')))
      req.end(data)
    })
  }

  async function start () {
    if (disposed) throw unavailable()
    if (configurationError) throw brokerError('E_BROKER_CONFIG', configurationError)
    if (!service) throw brokerError('E_BROKER_NOT_CONFIGURED', 'Install and configure the independent Anubis Broker on this device first')
    if (connection) return
    if (starting) return starting
    try { validateService() } catch (error) {
      if (error.code === 'E_BROKER_CONFIG') throw error
      throw brokerError('E_BROKER_CONFIG', 'The locally configured Broker service files are unavailable')
    }
    starting = new Promise((resolve, reject) => {
      let settled = false
      const proc = spawnProcess(service.nodePath, [service.entryPath], {
        cwd: path.dirname(service.entryPath),
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot || 'C:\\Windows',
          WINDIR: process.env.SystemRoot || 'C:\\Windows',
          ANUBIS_BROKER_CONFIG: service.configPath,
          ...(process.versions.electron && service.nodePath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {})
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
      child = proc
      const fail = error => {
        lastError = error.code || 'E_BROKER_START'
        if (!settled) { settled = true; clearTimeout(timer); reject(error) }
      }
      rejectStart = fail
      const timer = setTimeout(() => {
        fail(brokerError('E_BROKER_TIMEOUT', 'Broker readiness timed out'))
        if (proc.connected) proc.disconnect()
        proc.kill()
      }, timeoutMs)
      proc.stderr.on('data', () => { log('Module Broker reported a diagnostic; inspect its local configuration if startup fails') })
      proc.on('error', () => fail(brokerError('E_BROKER_START', 'Unable to start the configured module Broker')))
      proc.on('exit', () => {
        if (child === proc) { child = null; connection = null }
        for (const [req, owner] of pending) {
          if (owner.proc === proc) req.destroy(unavailable())
        }
        fail(unavailable())
      })
      proc.on('disconnect', () => {
        if (connection?.proc === proc) connection = null
        fail(unavailable())
        if (proc.exitCode === null) proc.kill()
      })
      proc.on('message', message => {
        if (settled || disposed || message?.type !== 'broker.ready') return
        const value = message.connection
        if (!value || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
            typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) {
          fail(brokerError('E_BROKER_PROTOCOL', 'Broker readiness response is invalid'))
          if (proc.connected) proc.disconnect()
          proc.kill()
          return
        }
        connection = { port: value.port, token: value.token, proc }
        lastError = null
        settled = true
        clearTimeout(timer)
        resolve()
      })
    })
    try { await starting } finally { starting = null; rejectStart = null }
  }

  const withBroker = async (method, route, payload) => {
    await start()
    return request(method, route, payload)
  }
  const jobId = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw brokerError('E_BAD_REQUEST', 'Invalid job ID')
    return value
  }
  return {
    async status () {
      if (disposed) throw unavailable()
      if (configurationError) throw brokerError('E_BROKER_CONFIG', configurationError)
      if (!service) return { configured: false, ready: false, executionEnabled: false, isolation: { network: 'not-enforced', account: 'inherited' } }
      const status = await withBroker('GET', 'status')
      return { ...status, configured: true, lastError }
    },
    modules: () => withBroker('GET', 'modules'),
    jobs: () => withBroker('GET', 'jobs?limit=100'),
    createJob: payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => !['moduleId', 'input', 'timeoutSec'].includes(key)) ||
          typeof payload.moduleId !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(payload.moduleId)) throw brokerError('E_BAD_REQUEST', 'Module ID and input are required')
      return withBroker('POST', 'jobs', payload)
    },
    getJob: id => withBroker('GET', 'jobs/' + jobId(id)),
    result: id => withBroker('GET', 'jobs/' + jobId(id) + '/result'),
    cancel: id => withBroker('POST', 'jobs/' + jobId(id) + '/cancel', {}),
    async dispose () {
      if (stopping) return stopping
      disposed = true
      const ready = !!connection
      connection = null
      if (rejectStart) rejectStart(unavailable())
      for (const req of pending.keys()) req.destroy(unavailable())
      const proc = child
      if (!proc) return
      stopping = new Promise(resolve => {
        const timer = setTimeout(() => { proc.kill(); resolve() }, 5000)
        proc.once('exit', () => { clearTimeout(timer); resolve() })
        if (ready && proc.connected) proc.send({ type: 'broker.stop' }, () => {})
        else {
          if (proc.connected) proc.disconnect()
          proc.kill()
        }
      })
      return stopping
    }
  }
}

module.exports = { createModuleBroker }
