'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { interactiveBrowserData, profileRoots } = require('../../app/lib/machine-browser-profile')

test('profile roots keep user profiles and drop the Windows directory and blank values', () => {
  const text = [
    '    ProfileImagePath    REG_EXPAND_SZ    C:\\Users\\alice',
    '    ProfileImagePath    REG_SZ    C:\\Windows\\System32\\config\\systemprofile',
    '    ProfileImagePath    REG_SZ    ',
    '    ProfileImagePath    REG_SZ    D:\\Users\\bob',
    '    not a registry value'
  ].join('\r\n')
  assert.deepEqual(profileRoots(() => text), ['C:\\Users\\alice', 'D:\\Users\\bob'])
})

test('interactive browser data prefers the newest profile and stays closed when the registry query fails', () => {
  const older = path.join('C:\\Users\\old', 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const newer = path.join('C:\\Users\\new', 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const missing = path.join('C:\\Users\\missing', 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const chosen = interactiveBrowserData('chrome', {
    query: () => [
      'ProfileImagePath REG_SZ C:\\Users\\old',
      'ProfileImagePath REG_SZ C:\\Users\\missing',
      'ProfileImagePath REG_SZ C:\\Users\\new'
    ].join('\n'),
    exists: candidate => candidate !== missing,
    stat: file => {
      if (file === path.join(older, 'Local State')) return { mtimeMs: 10 }
      if (file === path.join(newer, 'Local State')) return { mtimeMs: 50 }
      throw new Error('unexpected file ' + file)
    }
  })
  assert.equal(chosen, newer)

  const tied = path.join('C:\\Users\\tied', 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const laterWins = interactiveBrowserData('chrome', {
    query: () => 'ProfileImagePath REG_SZ C:\\Users\\new\nProfileImagePath REG_SZ C:\\Users\\tied',
    exists: () => true,
    stat: () => ({ mtimeMs: 50 })
  })
  assert.equal(laterWins, tied)

  const edge = interactiveBrowserData('edge', {
    query: () => 'ProfileImagePath REG_EXPAND_SZ C:\\Users\\edge',
    exists: () => true,
    stat: () => { throw new Error('no Local State') }
  })
  assert.equal(edge, path.join('C:\\Users\\edge', 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'))
  assert.equal(interactiveBrowserData('chrome', {
    query: () => { throw new Error('reg failed') }
  }), null)
})
