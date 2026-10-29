// Browser engine options for the web session panel. Kept as a plain CJS module
// (like browser-profile.js) so it can be imported by the JSX panel AND unit
// tested directly, since the web JSX has no unit-ci harness.
//
// Chrome/Edge drive the user's REAL local browser over CDP and are a PRO
// surface. The authoritative entitlement gate is the desktop sidebar
// (menu-preview.jsx), which fails OPEN; the web client cannot read entitlement
// at all. `entitled` therefore reflects that fail-open signal, defaulting to
// enabled, and only disables Chrome/Edge when entitlement is explicitly false.

const ENGINES = ['rbi', 'chrome', 'edge']

const PROFILE_NOTE = 'Switching to Chrome or Edge will close the running browser and use a managed copy of your profile.'

function normalizeEngine (engine) {
  return ENGINES.includes(engine) ? engine : 'rbi'
}

function isCdpEngine (engine) {
  return engine === 'chrome' || engine === 'edge'
}

function buildEngineOptions ({ entitled = true } = {}) {
  const locked = entitled === false
  return [
    { value: 'rbi', label: 'Internal (RBI)' },
    { value: 'chrome', label: 'Google Chrome', disabled: locked },
    { value: 'edge', label: 'Microsoft Edge', disabled: locked }
  ]
}

module.exports = {
  ENGINES,
  PROFILE_NOTE,
  normalizeEngine,
  isCdpEngine,
  buildEngineOptions
}
