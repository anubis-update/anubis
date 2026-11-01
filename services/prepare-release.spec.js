'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareRelease } = require('./prepare-release')

function makeTemp (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  fs.mkdirSync(input)
  return { input, output: path.join(root, 'output') }
}

function writeArtifact (directory, name) {
  fs.writeFileSync(path.join(directory, name), Buffer.from(name))
}

test('Windows installer-only release includes only its installer and blockmap', async t => {
  const { input, output } = makeTemp(t)
  writeArtifact(input, 'anubis-5.7.24-win-x64-installer.exe')
  writeArtifact(input, 'anubis-5.7.24-win-x64-installer.exe.blockmap')
  writeArtifact(input, 'anubis-5.7.24-linux-x64.tar.gz')
  writeArtifact(input, 'unreviewed.txt')

  assert.equal(await prepareRelease(input, output, '5.7.24', { windowsInstallerOnly: true }), 2)
  assert.deepEqual(fs.readdirSync(output).sort(), [
    'SHA256SUMS',
    'anubis-5.7.24-win-x64-installer.exe',
    'anubis-5.7.24-win-x64-installer.exe.blockmap'
  ])
})

test('standard release still requires all existing platform assets', async t => {
  const { input, output } = makeTemp(t)
  const suffixes = [
    'win-x64-installer.exe', 'win-x64-portable.tar.gz', 'win-x64.tar.gz',
    'linux-amd64.deb', 'linux-x64.tar.gz', 'linux-x86_64.AppImage',
    'mac-x64.dmg', 'mac-arm64.dmg'
  ]
  for (const suffix of suffixes) writeArtifact(input, `anubis-5.7.24-${suffix}`)

  assert.equal(await prepareRelease(input, output, '5.7.24'), suffixes.length)
  assert.equal(fs.readdirSync(output).length, suffixes.length + 1)
  assert(fs.existsSync(path.join(output, 'SHA256SUMS')))
})
