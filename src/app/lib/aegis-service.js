const fs = require('node:fs')
const path = require('node:path')
const { createCveScannerRunner } = require('./cve-scanner-runner')

function failure (code, message) {
  return Object.assign(new Error(message), { code })
}

function createAegisService ({ dataDir, modulesRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Modules'), runner, onError = console.error } = {}) {
  const file = path.join(dataDir, 'settings.json')
  const scanner = runner || createCveScannerRunner({
    modulesRoot,
    tempRoot: path.join(dataDir, 'runs'),
    stateFile: path.join(dataDir, 'latest.json'),
    onPersistenceError: error => onError('Could not persist Aegis results: ' + error.message)
  })
  let settings
  let settingsError
  const validate = value => {
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).sort().join(',') !== 'jsModulePath,pythonModulePath,revision' ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !['jsModulePath', 'pythonModulePath'].every(key => typeof value[key] === 'string' &&
          value[key].length <= 32768 && ![...value[key]].some(character => character.charCodeAt(0) < 32) && path.isAbsolute(value[key]))) {
      throw failure('INVALID_REQUEST', 'Two absolute module paths and a settings revision are required')
    }
    return value
  }
  function write (next) {
    fs.mkdirSync(dataDir, { recursive: true })
    const temporary = file + '.' + process.pid + '.tmp'
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary)
    }
  }
  try {
    settings = validate(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') {
      settings = { jsModulePath: path.join(modulesRoot, 'cve-scanner-js'), pythonModulePath: path.join(modulesRoot, 'cve-scanner-py'), revision: 0 }
      try { write(settings) } catch (error) { settingsError = error }
    } else settingsError = error
    if (settingsError) onError('Could not load Aegis module configuration: ' + settingsError.message)
  }
  const current = () => {
    if (settingsError) throw failure('INTERNAL', 'Aegis settings could not be read or saved. Restore the installation configuration before scanning.')
    return { ...settings }
  }
  const page = (run, { offset = 0, limit = 100 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_REQUEST', 'Invalid findings page')
    if (!run) return null
    const totalFindings = run.findings.length
    return { ...run, findings: run.findings.slice(offset, offset + limit), totalFindings, offset, nextOffset: offset + limit < totalFindings ? offset + limit : null }
  }
  return {
    handle (action, payload = {}) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('INVALID_REQUEST', 'Invalid Aegis request')
      if (['settings', 'latest'].includes(action)) {
        if (Object.keys(payload).length) throw failure('INVALID_REQUEST', 'This operation takes no parameters')
        return action === 'settings' ? current() : page(scanner.latest())
      }
      if (action === 'configure') {
        const next = validate(payload)
        const previous = current()
        if (next.revision !== previous.revision) throw failure('STALE_REF', 'Aegis paths changed in another session. Reload before saving.')
        if (['queued', 'running'].includes(scanner.latest()?.state)) throw failure('BUSY', 'Wait for the current scan before changing module paths')
        scanner.validatePaths({ jsModulePath: next.jsModulePath, pythonModulePath: next.pythonModulePath })
        const saved = { jsModulePath: next.jsModulePath, pythonModulePath: next.pythonModulePath, revision: previous.revision + 1 }
        try { write(saved) } catch (error) {
          onError('Could not save Aegis module paths: ' + error.message)
          throw failure('INTERNAL', 'Aegis paths could not be saved')
        }
        settings = saved
        return current()
      }
      if (action === 'start') {
        if (Object.keys(payload).length !== 1 || payload.confirmed !== true) throw failure('INVALID_REQUEST', 'Confirm public vulnerability lookups before starting both scanners')
        const saved = current()
        return page(scanner.start({ jsModulePath: saved.jsModulePath, pythonModulePath: saved.pythonModulePath }))
      }
      if (!['get', 'cancel'].includes(action) || !Object.keys(payload).every(key => (action === 'get' ? ['runId', 'offset', 'limit'] : ['runId']).includes(key)) ||
          typeof payload.runId !== 'string' || !/^[a-f0-9]{32}$/i.test(payload.runId)) throw failure('INVALID_REQUEST', 'Invalid Aegis operation or run ID')
      return page(scanner[action](payload.runId), action === 'get' ? payload : {})
    },
    dispose: () => scanner.dispose()
  }
}

module.exports = { createAegisService }
