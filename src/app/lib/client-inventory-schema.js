const MAX_SOFTWARE = 100
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160).trim() : ''
const statuses = new Set(['collecting', 'ok', 'unavailable', 'error', 'timeout'])

function normalizeClientInventory (raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !statuses.has(raw.status) ||
      ![null, 'user', 'admin', 'system'].includes(raw.role) ||
      !statuses.has(raw.security?.status) || !Array.isArray(raw.security.products) || raw.security.products.length > 32 ||
      !statuses.has(raw.software?.status) || !Array.isArray(raw.software.items) || raw.software.items.length > MAX_SOFTWARE ||
      typeof raw.software.truncated !== 'boolean' ||
      ![null, 'machine+current-user', 'unsupported'].includes(raw.software.scope) ||
      (raw.collectedAt !== null && (!Number.isSafeInteger(raw.collectedAt) || raw.collectedAt < 0))) throw new Error('Invalid client inventory')
  const products = raw.security.products.map(item => {
    if (typeof item === 'string') {
      if (item !== text(item) || !item) throw new Error('Invalid antivirus product name')
      return { name: item, enabled: null }
    }
    if (!item || typeof item.name !== 'string' || item.name !== text(item.name) || !item.name ||
        (item.enabled !== undefined && item.enabled !== null && typeof item.enabled !== 'boolean')) {
      throw new Error('Invalid antivirus product name')
    }
    return { name: item.name, enabled: item.enabled === true ? true : item.enabled === false ? false : null }
  })
  const ipv4 = []
  for (const item of Array.isArray(raw.ipv4) ? raw.ipv4 : []) {
    if (typeof item !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(item)) continue
    const parts = item.split('.').map(Number)
    if (parts.some(part => part > 255) || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)) continue
    if (!ipv4.includes(item)) ipv4.push(item)
    if (ipv4.length >= 8) break
  }
  const items = raw.software.items.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name || item.name !== text(item.name) ||
        typeof item.version !== 'string' || item.version !== text(item.version)) throw new Error('Invalid software inventory entry')
    return { name: item.name, version: item.version }
  })
  return {
    version: 1, status: raw.status, collectedAt: raw.collectedAt, role: raw.role, ipv4,
    security: { status: raw.security.status, products },
    software: { status: raw.software.status, scope: raw.software.scope, truncated: raw.software.truncated, items }
  }
}

module.exports = { normalizeClientInventory }
