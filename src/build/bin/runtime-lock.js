const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function stageRuntimeLock (root, destination) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
  const source = read(path.join(root, 'package.json'))
  const lock = read(path.join(root, 'package-lock.json'))
  const runtime = read(path.join(destination, 'package.json'))
  const metadata = lock.packages?.['']
  assert(metadata, 'A complete root package-lock.json is required for runtime preparation')
  assert.equal(lock.version, source.version, 'Root lock version differs from source')
  assert.equal(metadata.version, source.version, 'Root lock metadata version differs from source')
  assert.deepEqual(metadata.dependencies, source.dependencies, 'Root production dependency lock differs from source')
  assert.deepEqual(metadata.devDependencies, source.devDependencies, 'Root development dependency lock differs from source')
  assert.equal(runtime.name, source.name, 'Runtime package name differs from source')
  assert.equal(runtime.version, source.version, 'Runtime package version differs from source')
  const dependencies = { ...source.dependencies }
  delete dependencies[process.platform === 'win32' ? 'node-bash' : 'node-powershell']
  assert.deepEqual(runtime.dependencies, dependencies, 'Runtime dependency changes exceed platform preparation')
  assert.deepEqual(runtime.devDependencies, source.devDependencies, 'Runtime development dependencies differ from source')
  metadata.dependencies = runtime.dependencies
  delete metadata.engines
  fs.writeFileSync(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
}

module.exports = { stageRuntimeLock }
