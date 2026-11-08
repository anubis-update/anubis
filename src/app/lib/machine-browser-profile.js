'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RELATIVE = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data']
}

function profileRoots (query = defaultQuery) {
  const text = query()
  const roots = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = /REG_EXPAND_SZ\s+(.+)$/.exec(line.trim()) || /REG_SZ\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const value = match[1].trim()
    if (!value || /\\Windows\\/i.test(value)) continue
    roots.push(value)
  }
  return roots
}

function defaultQuery () {
  return execFileSync('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList',
    '/s',
    '/v',
    'ProfileImagePath'
  ], { encoding: 'utf8', windowsHide: true })
}

function interactiveBrowserData (engine, { exists = fs.existsSync, stat = fs.statSync, query } = {}) {
  const relative = RELATIVE[engine === 'edge' ? 'edge' : 'chrome']
  if (!relative) return null
  let roots = []
  try { roots = profileRoots(query) } catch { return null }
  let best = null
  let bestTime = -1
  for (const root of roots) {
    const candidate = path.join(root, 'AppData', 'Local', ...relative)
    if (!exists(candidate)) continue
    let time = 0
    try { time = stat(path.join(candidate, 'Local State')).mtimeMs } catch {}
    if (time >= bestTime) {
      best = candidate
      bestTime = time
    }
  }
  return best
}

module.exports = { interactiveBrowserData, profileRoots }
