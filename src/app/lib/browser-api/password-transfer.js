const crypto = require('node:crypto')
const { apiError } = require('./errors')
const { checkPassphrase, encryptPasswordFile, decryptPasswordFile } = require('./password-file')

function createPasswordTransfer ({ api, actor, nativeTransfer, now = Date.now, retainMs = 5 * 60000 } = {}) {
  let current = null
  let disposed = false
  const active = job => job && !['succeeded', 'failed', 'cancelled'].includes(job.state)
  const check = (browserId, kind) => {
    const driver = api.hub.forBrowser(browserId)
    if (!['chrome', 'edge'].includes(driver.engine)) throw apiError('NOT_SUPPORTED_BY_ENGINE', 'Native password transfer requires Chrome or Edge')
    if (api.policy.evaluate({ role: actor.role, command: 'passwords.' + kind, risk: 'sensitive', engine: driver.engine }).effect !== 'allow') throw apiError('POLICY_DENIED', 'Password transfer is disabled by device policy')
    api.leases.check({ browserId, actor: actor.id, role: actor.role })
    return driver
  }
  const clearExpired = () => {
    if (current && !active(current) && now() >= current.expiresAt) current = null
  }
  const publicJob = job => ({
    jobId: job.id,
    browserId: job.browserId,
    kind: job.kind,
    state: job.state,
    ...(job.error ? { error: job.error } : {}),
    ...(job.imported ? { imported: true } : {}),
    artifactReady: !!job.artifact
  })
  return {
    start (kind, payload) {
      if (disposed) throw apiError('DISABLED', 'Password transfers have been stopped')
      clearExpired()
      if (active(current)) throw apiError('BUSY', 'Another native password transfer is in progress')
      if (!['import', 'export'].includes(kind) || !payload || payload.confirmed !== true || typeof payload.browserId !== 'string') throw apiError('INVALID_REQUEST', 'Explicit administrator confirmation and a running browser are required')
      checkPassphrase(payload.passphrase)
      const driver = check(payload.browserId, kind)
      if (typeof nativeTransfer !== 'function' || typeof driver.nativePasswordTransfer !== 'function') throw apiError('CAPABILITY_MISSING', 'Native password file transfer is not configured in this build')
      api.audit.record({ actor, transport: 'admin-ui', command: 'passwords.' + kind, browserId: payload.browserId, decision: { effect: 'allow', rule: 'explicit-admin-native-file-transfer' }, outcome: { stage: 'confirmed' } })
      const job = { id: 'pw_' + crypto.randomBytes(12).toString('hex'), browserId: payload.browserId, kind, state: 'preparing', abort: new AbortController() }
      current = job
      let password = payload.passphrase
      let artifact = payload.artifact
      Promise.resolve().then(async () => {
        let plain
        let exported
        const checkCurrent = () => {
          if (job.abort.signal.aborted) throw apiError('CANCELLED', 'Password transfer was cancelled')
          check(job.browserId, kind)
        }
        try {
          if (kind === 'import') plain = await decryptPasswordFile(artifact, password)
          artifact = null
          checkCurrent()
          exported = await driver.nativePasswordTransfer(job.browserId, nativeTransfer, {
            kind,
            plain,
            signal: job.abort.signal,
            check: checkCurrent,
            progress: state => { if (!job.abort.signal.aborted || state === 'waiting_for_windows_dismissal') job.state = state }
          })
          checkCurrent()
          if (kind === 'export') {
            job.artifact = await encryptPasswordFile(exported.plain, password)
            checkCurrent()
          } else {
            if (!exported || exported.imported !== true) throw apiError('IMPORT_FAILED', 'The browser did not confirm password import')
            job.imported = true
          }
          api.audit.record({ actor, transport: 'admin-ui', command: 'passwords.' + kind, browserId: job.browserId, decision: { effect: 'allow', rule: 'explicit-admin-native-file-transfer' }, outcome: { stage: 'completed' } })
          job.state = 'succeeded'
        } catch (error) {
          job.artifact = null
          const cancelled = job.abort.signal.aborted && !['CLEANUP_FAILED', 'NATIVE_APPROVAL_REQUIRED'].includes(error.code)
          job.state = cancelled ? 'cancelled' : 'failed'
          job.error = { code: cancelled ? 'CANCELLED' : (typeof error.code === 'string' ? error.code : 'INTERNAL'), message: cancelled ? 'Password transfer was cancelled' : typeof error.code === 'string' ? error.message.slice(0, 300) : 'Native password transfer failed' }
        } finally {
          password = ''
          artifact = null
          if (plain) plain.fill(0)
          if (exported && exported.plain) exported.plain.fill(0)
          job.expiresAt = now() + retainMs
        }
      })
      return publicJob(job)
    },
    status ({ jobId } = {}) {
      clearExpired()
      if (jobId === undefined) return current ? publicJob(current) : { state: 'idle' }
      if (!current || current.id !== jobId) throw apiError('NOT_FOUND', 'Password transfer was not found or has expired')
      return publicJob(current)
    },
    result ({ jobId } = {}) {
      clearExpired()
      if (!current || current.id !== jobId) throw apiError('NOT_FOUND', 'Password transfer was not found or has expired')
      check(current.browserId, current.kind)
      if (current.state !== 'succeeded' || !current.artifact) throw apiError('BUSY', 'Encrypted password file is not available')
      return { artifact: current.artifact }
    },
    cancel ({ jobId } = {}) {
      if (!current || current.id !== jobId) throw apiError('NOT_FOUND', 'Password transfer was not found')
      if (active(current)) { current.state = 'cancelling'; current.abort.abort() } else current.artifact = null
      return publicJob(current)
    },
    dispose () {
      disposed = true
      if (active(current)) current.abort.abort()
      if (current) current.artifact = null
    }
  }
}

module.exports = { createPasswordTransfer }
