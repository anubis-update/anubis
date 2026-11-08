const SCARAB_SETTINGS_KEY = 'anubis.scarab.settings'
const SCARAB_DEFAULTS = {
  modulePath: 'C:\\ProgramData\\Anubis\\modules\\scarab',
  scanPath: 'C:\\Program Files (x86)',
  imageType: 'any',
  signState: 'signed',
  abuseCandidate: 'all',
  directoryPermission: 'any',
  greenDllCount: 2,
  greenExeSize: 10240,
  yellowDllCount: 5,
  yellowExeSize: 51200
}

function readScarabSettings (storage) {
  const settings = { ...SCARAB_DEFAULTS }
  try {
    const saved = JSON.parse(storage.getItem(SCARAB_SETTINGS_KEY) || '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings object')
    for (const key of ['modulePath', 'scanPath']) {
      if (typeof saved[key] === 'string') settings[key] = saved[key]
    }
    for (const [key, values] of Object.entries({
      imageType: ['any', 'x86', 'x64'],
      signState: ['any', 'signed'],
      abuseCandidate: ['all', 'best', 'good', 'bad'],
      directoryPermission: ['any', 'weak']
    })) {
      if (values.includes(saved[key])) settings[key] = saved[key]
    }
    for (const key of ['greenDllCount', 'greenExeSize', 'yellowDllCount', 'yellowExeSize']) {
      if (Number.isSafeInteger(saved[key]) && saved[key] >= 0) settings[key] = saved[key]
    }
    return { settings, error: '' }
  } catch (error) {
    return { settings, error: `Could not read saved Scarab settings: ${error.message}` }
  }
}

function filterCveFindings (findings, { type = 'all', severity = 'all', minCvss = null, includeCandidates = true } = {}) {
  return findings.filter(finding => {
    if (!includeCandidates && finding.candidate) return false
    const risk = String(finding.severity).toLowerCase()
    if (!['high', 'critical'].includes(risk) && !(finding.cvss >= 7)) return false
    if (severity !== 'all' && risk !== severity) return false
    if (minCvss != null && (!Number.isFinite(finding.cvss) || finding.cvss < minCvss)) return false
    if (type === 'kev' && !finding.knownExploited) return false
    if (type === 'other' && finding.knownExploited !== false) return false
    if (/^CWE-\d+$/.test(type) && !(finding.weaknesses || []).includes(type)) return false
    return true
  })
}

export { SCARAB_SETTINGS_KEY, SCARAB_DEFAULTS, readScarabSettings, filterCveFindings }
