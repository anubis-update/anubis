const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { stageRuntimeLock } = require('../../build/bin/runtime-lock')

test('runtime npm ci uses exact unpublished cached bytes offline, preserves hooks and rejects missing or corrupt cache', { timeout: 90000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-runtime-lock-'))
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  try {
    const sdk = path.join(root, 'sdk')
    const runtime = path.join(root, 'runtime')
    const cache = path.join(root, 'cache')
    fs.mkdirSync(sdk)
    fs.mkdirSync(runtime)
    fs.writeFileSync(path.join(root, 'empty-npmrc'), '')
    const npm = (command, cwd = root) => spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        npm_config_cache: cache,
        npm_config_userconfig: path.join(root, 'empty-npmrc'),
        npm_config_registry: 'http://127.0.0.1:9',
        npm_config_offline: 'true'
      }
    })
    const name = '@anubis-fixture/inventory'
    write(path.join(sdk, 'package.json'), {
      name, version: '9.9.9', scripts: { install: 'node install.js' }
    })
    fs.writeFileSync(path.join(sdk, 'install.js'), "require('node:fs').writeFileSync('lifecycle-ran', 'yes')\n")
    const packed = npm('npm pack --ignore-scripts --json --pack-destination ..', sdk)
    assert.equal(packed.status, 0, packed.stderr)
    const tar = JSON.parse(packed.stdout)[0]
    const bytes = fs.readFileSync(path.join(root, tar.filename))
    const integrity = 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64')
    assert.equal(integrity, tar.integrity)
    const omitted = process.platform === 'win32' ? 'node-bash' : 'node-powershell'
    const source = {
      name: 'runtime-fixture',
      version: '1.0.0',
      dependencies: { [name]: '9.9.9', [omitted]: '1.0.0' },
      devDependencies: { 'uncached-development-fixture': '1.0.0' }
    }
    const lock = {
      name: source.name,
      version: source.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { ...source },
        [`node_modules/${name}`]: {
          version: '9.9.9',
          resolved: 'http://127.0.0.1:9/unpublished-inventory-9.9.9.tgz',
          integrity,
          hasInstallScript: true
        },
        [`node_modules/${omitted}`]: { version: '1.0.0' },
        'node_modules/uncached-development-fixture': { version: '1.0.0', dev: true }
      }
    }
    write(path.join(root, 'package.json'), source)
    write(path.join(root, 'package-lock.json'), lock)
    const original = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
    const pack = { ...source, dependencies: { [name]: '9.9.9' }, main: 'app.js' }
    write(path.join(runtime, 'package.json'), pack)
    stageRuntimeLock(root, runtime)
    const staged = fs.readFileSync(path.join(runtime, 'package-lock.json'), 'utf8')
    const primed = npm(`npm cache add ${tar.filename}`)
    assert.equal(primed.status, 0, primed.stderr)
    const command = 'npm ci --omit=dev --legacy-peer-deps --offline --no-audit --no-fund'
    const installed = npm(command, runtime)
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(fs.readFileSync(path.join(runtime, `node_modules/${name}/lifecycle-ran`), 'utf8'), 'yes')
    assert(!fs.existsSync(path.join(runtime, 'node_modules/uncached-development-fixture')))
    assert(!fs.existsSync(path.join(runtime, `node_modules/${omitted}`)))
    assert.equal(fs.readFileSync(path.join(runtime, 'package-lock.json'), 'utf8'), staged)
    assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), original)
    const hash = crypto.createHash('sha512').update(bytes).digest('hex')
    const content = path.join(cache, '_cacache/content-v2/sha512', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4))
    fs.writeFileSync(content, 'corrupt')
    const corrupt = npm(command, runtime)
    assert.notEqual(corrupt.status, 0, corrupt.stdout)
    assert.match(corrupt.stderr, /ENOTCACHED|EINTEGRITY/)
    const missing = npm(command, runtime)
    assert.notEqual(missing.status, 0, missing.stdout)
    assert.match(missing.stderr, /ENOTCACHED/)
    write(path.join(runtime, 'package.json'), { ...pack, dependencies: { [name]: '10.0.0' } })
    assert.throws(() => stageRuntimeLock(root, runtime), /Runtime dependency changes exceed/)
    write(path.join(root, 'package-lock.json'), { ...lock, version: '0.0.0' })
    assert.throws(() => stageRuntimeLock(root, runtime), /Root lock version differs/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
