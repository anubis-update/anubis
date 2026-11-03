/**
 * Leases (SPEC-v1 §3.2): exclusive right to run write+ commands in a browser.
 * TTL is extended by every successful command. A local operator takeover
 * revokes the lease; the holder then gets LEASE_EXPIRED.
 */

const crypto = require('node:crypto')
const { apiError } = require('./errors')

function createLeaseManager ({ now = () => Date.now(), defaultTtlMs = 60000, maxTtlMs = 600000 } = {}) {
  const leases = new Map() // browserId -> lease
  const revoked = new Map() // leaseId -> reason

  function live (browserId) {
    const l = leases.get(browserId)
    if (l && l.expiresAt <= now()) {
      leases.delete(browserId)
      revoked.set(l.leaseId, 'expired')
      return null
    }
    return l || null
  }

  function acquire ({ browserId, actor, ttlMs = defaultTtlMs, scope = 'browser' }) {
    const cur = live(browserId)
    if (cur && cur.actor !== actor) throw apiError('BUSY', 'Another actor holds the lease')
    const ttl = Math.min(Math.max(1000, ttlMs), maxTtlMs)
    const lease = cur || { leaseId: 'l_' + crypto.randomBytes(8).toString('hex'), browserId, actor, scope, ttlMs: ttl }
    lease.ttlMs = ttl
    lease.expiresAt = now() + ttl
    leases.set(browserId, lease)
    return { leaseId: lease.leaseId, expiresAt: new Date(lease.expiresAt).toISOString(), ttlMs: ttl }
  }

  function release (leaseId, actor) {
    for (const [b, l] of leases) {
      if (l.leaseId === leaseId) {
        if (l.actor !== actor) throw apiError('POLICY_DENIED', 'Lease belongs to another actor')
        leases.delete(b)
        return { released: true }
      }
    }
    return { released: false }
  }

  function takeover (browserId) {
    const l = leases.get(browserId)
    if (!l) return false
    leases.delete(browserId)
    revoked.set(l.leaseId, 'takeover')
    return true
  }

  // Throws if `actor` may not run a write+ command. Operators (human) always may.
  function check ({ browserId, actor, role, leaseId }) {
    if (role === 'operator' || role === 'admin') return
    const l = live(browserId)
    if (leaseId && revoked.has(leaseId) && (!l || l.leaseId !== leaseId)) throw apiError('LEASE_EXPIRED', 'Lease expired or was revoked')
    if (!l) {
      if (leaseId) throw apiError('LEASE_EXPIRED', 'Lease expired or was revoked')
      return
    }
    if (l.actor !== actor) throw apiError('BUSY', 'Another actor holds the lease')
    if (!leaseId || leaseId !== l.leaseId) throw apiError('LEASE_REQUIRED', 'A valid leaseId is required')
  }

  function touch (browserId, actor) {
    const l = live(browserId)
    if (l && l.actor === actor) l.expiresAt = now() + l.ttlMs
  }

  return { acquire, release, takeover, check, touch, get: live }
}

module.exports = { createLeaseManager }
