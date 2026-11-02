const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { selectMachineUpdate, checkMachineUpdate, installMachineUpdate } = require('../../app/lib/machine-client-update')

const brand = {
  id: 'anubis',
  update: { enabled: true, baseUrls: ['https://update.anubis.locker'], releaseJson: '/data/anubis-github-release.json' },
  domains: { download: 'https://download.anubis.locker' }
}
const body = Buffer.alloc(8192, 42)
const asset = {
  name: 'anubis-5.6.13-win-x64-installer.exe',
  size: body.length,
  digest: 'sha256:' + crypto.createHash('sha256').update(body).digest('hex'),
  windows_machine_host: 1,
  browser_download_url: 'https://download.anubis.locker/releases/v5.6.13/anubis-5.6.13-win-x64-installer.exe'
}
const metadata = assets => ({ release: { tag_name: 'v5.6.13', assets: assets || [asset] } })
const selected = () => selectMachineUpdate(metadata(), brand, '5.6.12')

test('machine updater refuses downgrade, legacy installers, ambiguous artifacts and malformed integrity/origin', () => {
  assert.equal(selected().version, '5.6.13')
  assert.equal(selectMachineUpdate(metadata(), brand, '5.6.13').available, false)
  assert.equal(selectMachineUpdate(metadata(), brand, '6.0.0').available, false)
  for (const invalid of [
    { ...asset, windows_machine_host: undefined },
    { ...asset, windows_machine_host: true },
    { ...asset, digest: null },
    { ...asset, digest: 'sha256:short' },
    { ...asset, size: 0 },
    { ...asset, size: 2147483649 },
    { ...asset, browser_download_url: 'http://download.anubis.locker/file' },
    { ...asset, browser_download_url: 'https://untrusted.invalid/file' },
    { ...asset, browser_download_url: 'https://user@download.anubis.locker/file' }
  ]) assert.throws(() => selectMachineUpdate(metadata([invalid]), brand, '5.6.12'))
  for (const invalid of [
    metadata([asset, asset]),
    { release: { ...metadata().release, assets: {} } },
    { release: { ...metadata().release, tag_name: 'v1.2' } },
    { release: { ...metadata().release, draft: true } },
    { release: { ...metadata().release, prerelease: true } },
    null
  ]) assert.throws(() => selectMachineUpdate(invalid, brand, '5.6.12'))
})

test('machine updater fetches only configured HTTPS metadata without redirects or private headers', async () => {
  const seen = []
  const update = await checkMachineUpdate(brand, '5.6.12', async (url, options) => {
    seen.push({ url, options })
    return Response.json(metadata())
  })
  assert.equal(update.version, '5.6.13')
  assert.equal(seen[0].url, brand.update.baseUrls[0] + brand.update.releaseJson)
  assert.equal(seen[0].options.redirect, 'error')
  assert.deepEqual(seen[0].options.headers, { accept: 'application/json' })
  for (const response of [new Response('broken'), new Response(' '.repeat(1024 * 1024 + 1)), new Response('', { status: 503 })]) {
    await assert.rejects(checkMachineUpdate(brand, '5.6.12', async () => response), { code: 'ERR_HOST_UPDATE_METADATA' })
  }
  await assert.rejects(checkMachineUpdate(brand, '5.6.12', async () => {
    throw new DOMException('aborted', 'AbortError')
  }), { code: 'ERR_HOST_UPDATE_METADATA' })
  await assert.rejects(checkMachineUpdate({ ...brand, update: { ...brand.update, enabled: false } }, '5.6.12'), {
    code: 'ERR_HOST_UPDATE_DISABLED'
  })
})

async function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-machine-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const events = []
  let prepared = 0
  let launched = 0
  let discarded = 0
  const update = selected()
  const run = () => installMachineUpdate(update, {
    tempDir: root,
    notify: value => events.push(value),
    async fetcher (_url, config) {
      assert.equal(config.redirect, 'error')
      if (options.fetcher) return options.fetcher(config)
      return new Response(options.body ?? body, { status: options.status || 200 })
    },
    async prepare (file, actual) {
      prepared++
      assert.deepEqual(fs.readFileSync(file), body)
      assert.equal(actual.sha256, update.sha256)
      if (options.prepareError) throw new Error('native staging refused')
      return 'C:\\protected\\installer.exe'
    },
    async launch (file) {
      launched++
      assert.equal(file, 'C:\\protected\\installer.exe')
      if (options.launchError) throw new Error('UAC was cancelled')
    },
    async discard (file) {
      assert.equal(file, 'C:\\protected\\installer.exe')
      discarded++
    },
    signal: options.signal
  })
  return { root, events, run, prepared: () => prepared, launched: () => launched, discarded: () => discarded }
}

test('stream checksum precedes native protected copy; only protected path is launched and temp is removed', async t => {
  const f = await fixture(t)
  await f.run()
  assert.equal(f.prepared(), 1)
  assert.equal(f.launched(), 1)
  assert.deepEqual(fs.readdirSync(f.root), [])
  assert.equal(f.events.at(-1).phase, 'launch')
  assert.ok(f.events.filter(value => value.phase === 'download').every(value => value.percent <= 99))
})

test('partial, oversized, corrupted, failed and cancelled downloads never reach protected staging or installer', async t => {
  for (const options of [
    { body: body.subarray(1) }, { body: Buffer.concat([body, Buffer.from('extra')]) },
    { body: Buffer.alloc(body.length, 43) }, { status: 503 },
    { signal: AbortSignal.abort() }
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.run())
    assert.equal(f.prepared(), 0)
    assert.equal(f.launched(), 0)
    assert.deepEqual(fs.readdirSync(f.root), [])
  }
})

test('native protected-copy or UAC/launch failures remain explicit and retain the current GUI', async t => {
  for (const [options, code] of [
    [{ prepareError: true }, 'ERR_HOST_UPDATE_PREPARE'],
    [{ launchError: true }, 'ERR_HOST_UPDATE_LAUNCH']
  ]) {
    const f = await fixture(t, options)
    await assert.rejects(f.run(), { code })
    assert.equal(f.launched(), options.prepareError ? 0 : 1)
    assert.equal(f.discarded(), options.launchError ? 1 : 0)
    assert.deepEqual(fs.readdirSync(f.root), [])
  }
})

function downloadClock (t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(AbortSignal, 'timeout', delay => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), delay)
    return controller.signal
  })
}

test('a continuing slow download can exceed five minutes and still pass all integrity checks', async t => {
  downloadClock(t)
  let elapsed = 0
  const f = await fixture(t, {
    fetcher: () => new Response(new ReadableStream({
      async pull (controller) {
        await new Promise(resolve => setImmediate(resolve))
        t.mock.timers.tick(45000)
        const offset = elapsed / 45000 * 1024
        elapsed += 45000
        if (offset < body.length) controller.enqueue(body.subarray(offset, offset + 1024))
        else controller.close()
      }
    }))
  })
  await f.run()
  assert.ok(elapsed > 300000)
  assert.equal(f.prepared(), 1)
  assert.equal(f.launched(), 1)
  assert.deepEqual(fs.readdirSync(f.root), [])
})

test('stalled headers and stalled bodies abort after two idle minutes and remove temporary files', async t => {
  downloadClock(t)
  for (const headers of [true, false]) {
    let downloadSignal
    let started
    const downloadStarted = new Promise(resolve => { started = resolve })
    let cancelled = false
    const f = await fixture(t, {
      fetcher: ({ signal }) => {
        downloadSignal = signal
        started()
        if (headers) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        return new Response(new ReadableStream({
          start (controller) { controller.enqueue(body.subarray(0, 1024)) },
          cancel () { cancelled = true }
        }))
      }
    })
    const running = f.run()
    const rejected = assert.rejects(running, { code: 'ERR_HOST_UPDATE_DOWNLOAD' })
    await downloadStarted
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(119999)
    assert.equal(downloadSignal.aborted, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(downloadSignal.aborted, true)
    if (!headers) assert.equal(cancelled, true)
    assert.equal(f.prepared(), 0)
    assert.equal(f.launched(), 0)
    assert.deepEqual(fs.readdirSync(f.root), [])
  }
})

test('caller cancellation interrupts an in-flight download and clears the idle timer', async t => {
  downloadClock(t)
  const controller = new AbortController()
  let downloadSignal
  let started
  const downloadStarted = new Promise(resolve => { started = resolve })
  const f = await fixture(t, {
    signal: controller.signal,
    fetcher: ({ signal }) => {
      downloadSignal = signal
      started()
      return new Response(new ReadableStream({ start () {} }))
    }
  })
  const running = f.run()
  const rejected = assert.rejects(running, { code: 'ERR_HOST_UPDATE_DOWNLOAD' })
  await downloadStarted
  controller.abort()
  await rejected
  assert.equal(downloadSignal.aborted, true)
  assert.equal(f.prepared(), 0)
  assert.equal(f.launched(), 0)
  assert.deepEqual(fs.readdirSync(f.root), [])
})

test('continuous progress is still bounded by a two-hour total download deadline', async t => {
  downloadClock(t)
  let offset = 0
  let elapsed = 0
  const f = await fixture(t, {
    fetcher: () => new Response(new ReadableStream({
      async pull (controller) {
        await new Promise(resolve => setImmediate(resolve))
        elapsed += 45000
        t.mock.timers.tick(45000)
        if (offset < body.length) controller.enqueue(body.subarray(offset, offset += 32))
        else controller.close()
      }
    }))
  })
  await assert.rejects(f.run(), { code: 'ERR_HOST_UPDATE_DOWNLOAD' })
  assert.ok(elapsed >= 2 * 60 * 60 * 1000)
  assert.equal(f.prepared(), 0)
  assert.equal(f.launched(), 0)
  assert.deepEqual(fs.readdirSync(f.root), [])
})
