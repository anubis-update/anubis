const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { interactiveBrowserData, profileRoots } = require('../../app/lib/machine-browser-profile')

const registry = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-18',
  '    ProfileImagePath    REG_EXPAND_SZ    C:\\Windows\\System32\\config\\systemprofile',
  '    ProfileImagePath    REG_SZ    C:\\Users\\Ada',
  '    ProfileImagePath    REG_EXPAND_SZ    D:\\Profiles\\Grace',
  '    ProfileImagePath    REG_SZ    ',
  '    NotAPath    REG_DWORD    0x1'
].join('\r\n')

test('profile roots keep user profiles and skip Windows system profiles', () => {
  assert.deepEqual(profileRoots(() => registry), ['C:\\Users\\Ada', 'D:\\Profiles\\Grace'])
  assert.deepEqual(profileRoots(() => ''), [])
})

test('interactive browser data uses the newest Local State for the requested engine', () => {
  const ada = 'C:\\Users\\Ada'
  const grace = 'D:\\Profiles\\Grace'
  const chrome = root => path.join(root, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  const edge = root => path.join(root, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')
  const times = new Map([
    [path.join(chrome(ada), 'Local State'), 10],
    [path.join(chrome(grace), 'Local State'), 10],
    [path.join(edge(ada), 'Local State'), 5],
    [path.join(edge(grace), 'Local State'), 40]
  ])
  const options = {
    query: () => registry,
    exists: candidate => candidate === chrome(ada) || candidate === chrome(grace) || candidate === edge(ada) || candidate === edge(grace),
    stat: file => {
      if (!times.has(file)) throw new Error('missing')
      return { mtimeMs: times.get(file) }
    }
  }
  assert.equal(interactiveBrowserData('chrome', options), chrome(grace))
  assert.equal(interactiveBrowserData('edge', options), edge(grace))
  assert.equal(interactiveBrowserData('chrome', {
    ...options,
    exists: candidate => candidate === chrome(ada)
  }), chrome(ada))
  assert.equal(interactiveBrowserData('chrome', {
    query: () => { throw new Error('registry unavailable') }
  }), null)
  assert.equal(interactiveBrowserData('chrome', {
    query: () => 'ProfileImagePath    REG_SZ    C:\\Users\\Ada',
    exists: () => false
  }), null)
})
