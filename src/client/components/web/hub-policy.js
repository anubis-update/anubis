// Pure helpers for the Browser Hub UI: risk classification, default-deny list
// and policy validation (SPEC-v1 section 7). No React, unit-testable.

// Commands the policy editor always lists (agentDefault=deny in registry.json
// plus the confirm-by-default ones); the live policy may add more rules.
const DEFAULT_DENY = [
  'page.evaluate',
  'cookies.export',
  'cookies.import',
  'history.clear',
  'passwords.import',
  'passwords.export',
  'storage.get',
  'storage.set',
  'storage.clear',
  'extension.install',
  'extension.remove',
  'devMode.set'
]

const DANGEROUS = [
  'page.evaluate',
  'history.clear',
  'passwords.import',
  'passwords.export',
  'storage.clear',
  'extension.install',
  'extension.remove',
  'devMode.set'
]

const EFFECTS = ['allow', 'confirm', 'deny']

const DANGER_TEXT = {
  'passwords.export': 'Exports saved passwords in PLAIN TEXT. Anyone with the file can read them. Store it securely and delete it after use.',
  'passwords.import': 'Importing passwords overwrites matching saved entries in the browser profile.',
  'history.clear': 'Permanently deletes browsing history. This cannot be undone.',
  'extension.install': 'Installing an extension grants it access to pages you visit. Only load code you trust.',
  'extension.remove': 'Removes the extension and its data.',
  'devMode.set': 'Developer mode lets extensions and pages run unvetted code.',
  'storage.clear': 'Permanently clears site storage.',
  'page.evaluate': 'Runs arbitrary JavaScript in the page.'
}

function isDangerous (command) {
  return DANGEROUS.includes(command)
}

function dangerText (command) {
  return DANGER_TEXT[command] || 'This action is dangerous.'
}

function validatePolicy (policy) {
  const errors = []
  if (!policy || typeof policy !== 'object') return ['Policy must be an object']
  if (policy.defaultEffect !== 'deny') errors.push('defaultEffect must be "deny"')
  const roles = policy.roles || {}
  Object.keys(roles).forEach(role => {
    const rules = (roles[role] && roles[role].rules) || []
    rules.forEach((r, i) => {
      if (!r.command) errors.push(`${role} rule ${i + 1}: command required`)
      if (!EFFECTS.includes(r.effect)) errors.push(`${role} rule ${i + 1}: bad effect`)
    })
  })
  return errors
}

// Same glob semantics as the backend policy engine: '*', 'ns.*', exact
function globMatch (pattern, name) {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

// First match wins; no match -> deny (default-deny)
function effectFor (policy, role, command) {
  const rules = (((policy || {}).roles || {})[role] || {}).rules || []
  const hit = rules.find(r => globMatch(r.command, command))
  return hit ? hit.effect : 'deny'
}

function setRule (policy, role, command, effect) {
  if (!policy || typeof policy !== 'object') return policy
  const next = JSON.parse(JSON.stringify(policy))
  next.roles = next.roles || {}
  next.roles[role] = next.roles[role] || { firstMatchWins: true, rules: [] }
  const rules = next.roles[role].rules
  const hit = rules.find(r => r.command === command)
  if (hit) hit.effect = effect
  else rules.unshift({ command, effect })
  return next
}

module.exports = {
  DEFAULT_DENY,
  DANGEROUS,
  EFFECTS,
  isDangerous,
  dangerText,
  validatePolicy,
  effectFor,
  setRule
}
