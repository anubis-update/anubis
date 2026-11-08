const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  createCdpLaunch,
  createCdpClient,
  detectBrowserPath,
  buildLaunchArgs,
  copyProfileTolerant,
  HARDENING_FLAGS
} = require('../../app/lib/cdp-launch')

// A fake transport that drives createCdpClient: records sent frames and lets the
// test push protocol messages back. It auto-answers the Target.* attach
// handshake (setDiscoverTargets/getTargets/attachToTarget) so cdpClient() can
// resolve; every other method is still driven manually via emitMessage.
function fakeTransport () {
  const emitter = new EventEmitter()
  const t = {
    sent: [],
    closed: false,
    auto: true,
    on: (ev, cb) => emitter.on(ev, cb),
    emitMessage: (obj) => emitter.emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj)),
    emitClose: () => emitter.emit('close'),
    send (str) {
      const msg = JSON.parse(str)
      t.sent.push(msg)
      if (!t.auto) return
      const reply = (result) => queueMicrotask(() => t.emitMessage({ id: msg.id, result }))
      if (msg.method === 'Target.setDiscoverTargets') reply({})
      else if (msg.method === 'Target.getTargets') reply({ targetInfos: [{ targetId: 'T1', type: 'page' }] })
      else if (msg.method === 'Target.createTarget') reply({ targetId: 'T1' })
      else if (msg.method === 'Target.attachToTarget') reply({ sessionId: 'S1' })
      else if (msg.method === 'Target.activateTarget') reply({})
      else if (msg.method === 'Page.bringToFront') reply({})
    },
    close () { t.closed = true }
  }
  return t
}

test('detectBrowserPath returns the first existing candidate', () => {
  const env = { PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PFx86', LOCALAPPDATA: 'C:\\LA' }
  const found = 'C:\\PFx86\\Google\\Chrome\\Application\\chrome.exe'
  const path = detectBrowserPath('chrome', { env, fsExists: (p) => p === found })
  assert.equal(path, found)
})

test('detectBrowserPath returns null when nothing is installed', () => {
  assert.equal(detectBrowserPath('edge', { env: {}, fsExists: () => false }), null)
})

test('detectBrowserPath resolves edge candidates', () => {
  const env = { 'PROGRAMFILES(X86)': 'C:\\PFx86' }
  const found = 'C:\\PFx86\\Microsoft\\Edge\\Application\\msedge.exe'
  assert.equal(detectBrowserPath('edge', { env, fsExists: (p) => p === found }), found)
})

test('buildLaunchArgs uses the pipe flag, user-data-dir, hardening and window size', () => {
  const args = buildLaunchArgs({ userDataDir: 'C:\\managed', width: 800, height: 600, pipe: true, url: 'https://x.com' })
  assert.ok(args.includes('--remote-debugging-pipe'))
  assert.ok(args.includes('--user-data-dir=C:\\managed'))
  for (const flag of HARDENING_FLAGS) assert.ok(args.includes(flag), 'has ' + flag)
  assert.ok(args.includes('--window-size=800,600'))
  assert.equal(args.at(-1), 'https://x.com')
})

test('hardening disables native window occlusion so the screencast keeps painting', () => {
  // Regression guard: without CalculateNativeWinOcclusion disabled Chromium on
  // Windows stops painting an unfocused window and startScreencast emits no
  // frames (proven live). These flags are load-bearing for streaming.
  assert.ok(HARDENING_FLAGS.includes('--disable-features=TranslateUI,CalculateNativeWinOcclusion'))
  assert.ok(HARDENING_FLAGS.includes('--disable-backgrounding-occluded-windows'))
  assert.ok(HARDENING_FLAGS.includes('--disable-renderer-backgrounding'))
})

test('buildLaunchArgs switches to an ephemeral port when pipe is false', () => {
  const args = buildLaunchArgs({ userDataDir: 'C:\\m', pipe: false })
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(!args.includes('--remote-debugging-pipe'))
})

test('createCdpClient correlates responses by id and routes events', async () => {
  const transport = fakeTransport()
  const client = createCdpClient(transport)
  const events = []
  client.on('Page.frameNavigated', (p) => events.push(p))
  const promise = client.send('Page.navigate', { url: 'https://x.com' })
  assert.equal(transport.sent[0].method, 'Page.navigate')
  const sentId = transport.sent[0].id
  transport.emitMessage({ id: sentId, result: { frameId: 'f1' } })
  assert.deepEqual(await promise, { frameId: 'f1' })
  transport.emitMessage({ method: 'Page.frameNavigated', params: { frame: { url: 'https://x.com' } } })
  assert.deepEqual(events, [{ frame: { url: 'https://x.com' } }])
})

test('createCdpClient rejects when CDP returns an error', async () => {
  const transport = fakeTransport()
  const client = createCdpClient(transport)
  const promise = client.send('Bad.method')
  transport.emitMessage({ id: transport.sent[0].id, error: { message: 'no such method' } })
  await assert.rejects(promise, /no such method/)
})

test('createCdpClient rejects in-flight calls when the transport closes', async () => {
  const transport = fakeTransport()
  const client = createCdpClient(transport)
  const promise = client.send('Page.enable')
  transport.emitClose()
  await assert.rejects(promise, /closed/)
})

function launchFixture (overrides = {}) {
  const spawns = []
  const copies = []
  const transport = fakeTransport()
  const deps = {
    spawn: (cmd, args, opts) => {
      const child = { cmd, args, opts, killed: false, kill () { this.killed = true } }
      spawns.push(child)
      return child
    },
    fsExists: p => !p.startsWith('C:\\managed'),
    detectPath: () => 'C:\\chrome.exe',
    copyProfile: async (src, dst) => { copies.push({ src, dst }) },
    resolveUserDataDir: () => 'C:\\managed\\cdp-chrome',
    resolveSourceProfile: () => 'C:\\LA\\Google\\Chrome\\User Data',
    connectPipe: async () => transport,
    connectPort: async () => transport,
    readDevToolsEndpoint: async () => 'ws://127.0.0.1:1234/devtools/page/abc',
    env: {},
    log: { warn () {} },
    ...overrides
  }
  const launch = createCdpLaunch(deps)
  return { launch, spawns, copies, transport, deps }
}

test('createCdpLaunch requires spawn and resolveUserDataDir', () => {
  assert.throws(() => createCdpLaunch({ resolveUserDataDir: () => '' }), /spawn/)
  assert.throws(() => createCdpLaunch({ spawn: () => {} }), /resolveUserDataDir/)
})

test('launcher detects the path, copies the profile and spawns with pipe flags', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', width: 800, height: 600, browser: 'chrome' })
  assert.equal(f.copies.length, 1)
  assert.equal(f.copies[0].src, 'C:\\LA\\Google\\Chrome\\User Data')
  assert.equal(f.copies[0].dst, 'C:\\managed\\cdp-chrome')
  assert.equal(f.spawns.length, 1)
  assert.equal(f.spawns[0].cmd, 'C:\\chrome.exe')
  assert.ok(f.spawns[0].args.includes('--remote-debugging-pipe'))
  assert.ok(f.spawns[0].args.includes('--user-data-dir=C:\\managed\\cdp-chrome'))
  assert.equal(handle.mode, 'pipe')
  assert.equal(handle.userDataDir, 'C:\\managed\\cdp-chrome')
})

test('launcher falls back to an ephemeral port when the pipe connect fails', async () => {
  const f = launchFixture({ connectPipe: async () => { throw new Error('pipe refused') } })
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  // the pipe child was spawned then killed, and a second port child was spawned
  assert.equal(f.spawns.length, 2)
  assert.equal(f.spawns[0].killed, true)
  assert.ok(f.spawns[0].args.includes('--remote-debugging-pipe'))
  assert.ok(f.spawns[1].args.includes('--remote-debugging-port=0'))
  assert.equal(handle.mode, 'port')
})

test('shared launcher never overwrites an existing managed profile on restart', async () => {
  const f = launchFixture({ fsExists: p => p === 'C:\\managed\\cdp-chrome\\Default\\Preferences' })
  const handle = await f.launch.launcher()
  assert.equal(f.copies.length, 0)
  handle.close()
})

test('selecting an unseeded profile copies only that directory in an existing managed root', async () => {
  const f = launchFixture({
    fsExists: p => !p.endsWith('Preferences'),
    resolveLaunchOptions: () => ({ profileDirectory: 'Profile 2' })
  })
  const handle = await f.launch.launcher()
  assert.deepEqual(f.copies, [{
    src: 'C:\\LA\\Google\\Chrome\\User Data\\Profile 2',
    dst: 'C:\\managed\\cdp-chrome\\Profile 2'
  }])
  handle.close()
})

for (const preferPipe of [true, false]) {
  test(`shared launcher applies selected profile and extension permission (pipe=${preferPipe})`, async () => {
    let options = { profileId: 'p_work', profileDirectory: 'Profile 1', unsafeExtensionDebugging: true }
    let reads = 0
    const f = launchFixture({
      preferPipe,
      resolveLaunchOptions: engine => {
        assert.equal(engine, 'chrome')
        reads++
        return options
      }
    })
    const first = await f.launch.launcher({ id: 'one' })
    assert.ok(f.spawns[0].args.includes('--profile-directory=Profile 1'))
    assert.ok(f.spawns[0].args.includes('--enable-unsafe-extension-debugging'))
    assert.equal(first.profileId, 'p_work')
    assert.equal(first.profileDirectory, 'Profile 1')
    options = { profileDirectory: 'Default', unsafeExtensionDebugging: false }
    const reused = await f.launch.launcher({ id: 'two' })
    assert.equal(reads, 1, 'Settings must not change a running shared process')
    assert.equal(reused.profileDirectory, 'Profile 1')
    first.close()
    reused.close()
    const next = await f.launch.launcher({ id: 'three' })
    assert.equal(reads, 2)
    assert.equal(next.profileDirectory, 'Default')
    assert.ok(!f.spawns[1].args.includes('--enable-unsafe-extension-debugging'))
    next.close()
  })
}

test('shared launcher leaves unsafe extension debugging off by default and rejects invalid profiles', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'one' })
  assert.ok(!f.spawns[0].args.includes('--enable-unsafe-extension-debugging'))
  handle.close()
  const invalid = launchFixture({ resolveLaunchOptions: () => ({ profileDirectory: '..\\other' }) })
  await assert.rejects(invalid.launch.launcher({ id: 'invalid' }), { code: 'PROFILE_NOT_FOUND' })
  assert.equal(invalid.spawns.length, 0)
})

test('launcher refuses when the browser is already running, with a specific code', async () => {
  const f = launchFixture({ isBrowserRunning: async () => true })
  await assert.rejects(
    f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' }),
    (error) => error.code === 'BROWSER_ALREADY_RUNNING' && /Close your running/.test(error.message)
  )
  assert.equal(f.spawns.length, 0)
})

test('launcher throws BROWSER_NOT_FOUND when no executable is detected', async () => {
  const f = launchFixture({ detectPath: () => null })
  await assert.rejects(
    f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'edge' }),
    (error) => error.code === 'BROWSER_NOT_FOUND'
  )
})

test('cdpClient attaches to a page target and routes page-domain commands through its session', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const client = await f.launch.cdpClient(handle)
  // the attach handshake ran on the browser-level connection (no sessionId)
  const handshake = f.transport.sent.filter(s => /^Target\./.test(s.method)).map(s => s.method)
  assert.deepEqual(handshake, ['Target.setDiscoverTargets', 'Target.getTargets', 'Target.attachToTarget', 'Target.activateTarget'])
  assert.equal(f.transport.sent.find(s => s.method === 'Target.attachToTarget').params.flatten, true)
  // page-domain commands now carry the attached session id at the top level
  const events = []
  client.on('Page.loadEventFired', () => events.push('load'))
  const promise = client.send('Page.enable')
  const enable = f.transport.sent.at(-1)
  assert.equal(enable.method, 'Page.enable')
  assert.equal(enable.sessionId, 'S1')
  f.transport.emitMessage({ id: enable.id, result: {} })
  await promise
  // a session-scoped event is delivered to the facade listener
  f.transport.emitMessage({ sessionId: 'S1', method: 'Page.loadEventFired', params: {} })
  assert.deepEqual(events, ['load'])
})

test('cdpClient creates a page target when the browser exposes none', async () => {
  const f = launchFixture()
  f.transport.auto = false
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const pending = f.launch.cdpClient(handle)
  // answer the handshake manually: no page target -> createTarget -> attach
  const answer = (method, result) => {
    const hit = [...f.transport.sent].reverse().find(s => s.method === method)
    f.transport.emitMessage({ id: hit.id, result })
  }
  await new Promise(resolve => setImmediate(resolve)); answer('Target.setDiscoverTargets', {})
  await new Promise(resolve => setImmediate(resolve)); answer('Target.getTargets', { targetInfos: [] })
  await new Promise(resolve => setImmediate(resolve)); answer('Target.createTarget', { targetId: 'NEW' })
  await new Promise(resolve => setImmediate(resolve)); answer('Target.attachToTarget', { sessionId: 'S9' })
  await new Promise(resolve => setImmediate(resolve)); answer('Target.activateTarget', {})
  await new Promise(resolve => setImmediate(resolve)); answer('Page.bringToFront', {})
  await pending
  assert.ok(f.transport.sent.some(s => s.method === 'Target.createTarget'))
  assert.equal(f.transport.sent.find(s => s.method === 'Target.attachToTarget').params.targetId, 'NEW')
})

test('browser-level events with no sessionId still reach the page facade (titles)', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const client = await f.launch.cdpClient(handle)
  const titles = []
  client.on('Target.targetInfoChanged', (p) => titles.push(p.targetInfo.title))
  f.transport.emitMessage({ method: 'Target.targetInfoChanged', params: { targetInfo: { title: 'Hi' } } })
  assert.deepEqual(titles, ['Hi'])
})

test('a re-open of the same browser reuses the live process (no second spawn)', async () => {
  const f = launchFixture()
  const h1 = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const h2 = await f.launch.launcher({ id: 'b', url: 'https://y.com', browser: 'chrome' })
  assert.equal(f.spawns.length, 1, 'only one browser process is spawned')
  assert.equal(f.copies.length, 1, 'profile is copied once')
  assert.equal(h2.child, h1.child, 'both handles share the live child')
  // first close is reference-counted: the shared process stays up
  h1.close()
  assert.equal(f.spawns[0].killed, false)
  // last close tears the shared process down
  h2.close()
  assert.equal(f.spawns[0].killed, true)
  assert.equal(f.transport.closed, true)
})

test('a reused handle opens its own page target (new tab) instead of sharing one', async () => {
  const f = launchFixture()
  await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const h2 = await f.launch.launcher({ id: 'b', url: 'https://y.com', browser: 'chrome' })
  assert.equal(h2.reused, true)
  f.transport.sent.length = 0
  await f.launch.cdpClient(h2)
  const methods = f.transport.sent.map(s => s.method)
  assert.ok(methods.includes('Target.createTarget'), 'reused session creates its own page target')
  assert.ok(!methods.includes('Target.getTargets'), 'reused session does not reuse the existing page')
})

test('startScreencast retries after "Not attached to an active page"', async () => {
  const f = launchFixture()
  f.transport.auto = false
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const pending = f.launch.cdpClient(handle)
  const answer = (method, result) => {
    const hit = [...f.transport.sent].reverse().find(s => s.method === method && !s._answered)
    hit._answered = true
    f.transport.emitMessage({ id: hit.id, result })
  }
  const err = (method, message) => {
    const hit = [...f.transport.sent].reverse().find(s => s.method === method && !s._answered)
    hit._answered = true
    f.transport.emitMessage({ id: hit.id, error: { message } })
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  await tick(); answer('Target.setDiscoverTargets', {})
  await tick(); answer('Target.getTargets', { targetInfos: [{ targetId: 'T1', type: 'page' }] })
  await tick(); answer('Target.attachToTarget', { sessionId: 'S1' })
  await tick(); answer('Target.activateTarget', {})
  await tick(); answer('Page.bringToFront', {})
  const client = await pending
  const started = client.send('Page.startScreencast', { format: 'jpeg' })
  await tick(); err('Page.startScreencast', 'Not attached to an active page')
  await tick(); answer('Target.activateTarget', {})
  await tick(); answer('Page.bringToFront', {})
  await new Promise(resolve => setTimeout(resolve, 200))
  await tick(); answer('Page.startScreencast', { ok: true })
  assert.deepEqual(await started, { ok: true })
  const starts = f.transport.sent.filter(s => s.method === 'Page.startScreencast')
  assert.equal(starts.length, 2, 'startScreencast was retried once')
})

test('launcher continues when the profile copy fails (best-effort seed)', async () => {
  const f = launchFixture({ copyProfile: async () => { throw new Error('locked') } })
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  assert.equal(handle.mode, 'pipe')
  assert.equal(f.spawns.length, 1)
})

test('launcher fails fast with PROFILE_SOURCE_MISSING when the source profile is absent', async () => {
  const f = launchFixture({ fsExists: () => false })
  await assert.rejects(
    f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' }),
    (error) => error.code === 'PROFILE_SOURCE_MISSING'
  )
  assert.equal(f.spawns.length, 0, 'no browser is spawned when the source profile is missing')
  assert.equal(f.copies.length, 0, 'no copy is attempted when the source profile is missing')
})

test('copyProfileTolerant clones identity files, skips cache dirs and lock files', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-copy-'))
  const src = path.join(base, 'src')
  const dst = path.join(base, 'dst')
  fs.mkdirSync(path.join(src, 'Default', 'Network'), { recursive: true })
  fs.mkdirSync(path.join(src, 'Default', 'Cache'), { recursive: true })
  fs.mkdirSync(path.join(src, 'Default', 'Service Worker'), { recursive: true })
  fs.writeFileSync(path.join(src, 'Local State'), 'key')
  fs.writeFileSync(path.join(src, 'lockfile'), 'x')
  fs.writeFileSync(path.join(src, 'Default', 'Cookies'), 'c')
  fs.writeFileSync(path.join(src, 'Default', 'Network', 'Cookies'), 'c')
  fs.writeFileSync(path.join(src, 'Default', 'Cache', 'data_0'), 'big')
  fs.writeFileSync(path.join(src, 'Default', 'Service Worker', 'sw'), 'big')

  await copyProfileTolerant(src, dst)

  assert.ok(fs.existsSync(path.join(dst, 'Local State')), 'Local State copied')
  assert.ok(fs.existsSync(path.join(dst, 'Default', 'Cookies')), 'cookies copied')
  assert.ok(fs.existsSync(path.join(dst, 'Default', 'Network', 'Cookies')), 'network cookies copied')
  assert.ok(!fs.existsSync(path.join(dst, 'lockfile')), 'lock file skipped')
  assert.ok(!fs.existsSync(path.join(dst, 'Default', 'Cache')), 'cache dir skipped')
  assert.ok(!fs.existsSync(path.join(dst, 'Default', 'Service Worker')), 'service worker dir skipped')
  fs.rmSync(base, { recursive: true, force: true })
})

test('copyProfileTolerant does not throw when the source profile is absent', async () => {
  await copyProfileTolerant('C:\\no\\such\\profile\\here', 'C:\\no\\such\\dest\\here')
})
