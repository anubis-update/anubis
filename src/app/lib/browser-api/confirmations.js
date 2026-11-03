/**
 * Confirmations: local-UI only. Agents can never approve their own requests.
 * `request()` returns a promise resolved by `resolve(id, decision, localToken)`;
 * the localToken is a secret known only to the local UI bridge. With no
 * approver registered the caller gets CONFIRMATION_REQUIRED immediately.
 */

const crypto = require('node:crypto')
const { apiError } = require('./errors')

function createConfirmations ({ emit = () => {}, now = () => Date.now(), timeoutSec = 120, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map()
  const localToken = crypto.randomBytes(24).toString('hex')
  let approverCount = 0

  function request ({ command, summary, actor }) {
    if (approverCount === 0) {
      return Promise.reject(apiError('CONFIRMATION_REQUIRED', 'No local approver is available; confirm in the Anubis UI'))
    }
    const confirmationId = 'c_' + crypto.randomBytes(8).toString('hex')
    const expiresAt = new Date(now() + timeoutSec * 1000).toISOString()
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(confirmationId)
        reject(apiError('CONFIRMATION_TIMEOUT', 'Confirmation timed out'))
      }, timeoutSec * 1000)
      pending.set(confirmationId, { resolve, reject, timer, command, summary, actor, expiresAt })
      emit('confirmation.requested', { data: { confirmationId, command, summary: String(summary).slice(0, 300), expiresAt } })
    })
  }

  function decide (confirmationId, approve, token) {
    const a = Buffer.from(String(token || ''))
    const b = Buffer.from(localToken)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw apiError('POLICY_DENIED', 'Only the local UI may decide confirmations')
    const p = pending.get(confirmationId)
    if (!p) throw apiError('INVALID_REQUEST', 'Unknown or expired confirmation')
    pending.delete(confirmationId)
    clearTimer(p.timer)
    if (approve) p.resolve(true)
    else p.reject(apiError('CONFIRMATION_REJECTED', 'The operator denied the request'))
    return { decided: true }
  }

  function registerApprover () {
    approverCount++
    return () => { approverCount = Math.max(0, approverCount - 1) }
  }

  return {
    request,
    decide,
    registerApprover,
    list: () => [...pending].map(([id, p]) => ({ confirmationId: id, command: p.command, summary: p.summary, expiresAt: p.expiresAt })),
    localToken: () => localToken
  }
}

module.exports = { createConfirmations }
