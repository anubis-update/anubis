const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  createCdpLaunch,
  createCdpClient,
  detectBrowserPath,
  buildLaunchArgs,
  HARDENING_FLAGS
} = require('../../app/lib/cdp-launch')

// A fake transport that drives createCdpClient: records sent frames and lets the
// test push protocol messages back.
function fakeTransport () {
  const emitter = new EventEmitter()
  return {
    sent: [],
    closed: false,
    on: (ev, cb) => emitter.on(ev, cb),
    emitMessage: (obj) => emitter.emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj)),
    emitClose: () => emitter.emit('close'),
    send (str) { this.sent.push(JSON.parse(str)) },
    close () { this.closed = true }
  }
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
    fsExists: () => true,
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

test('cdpClient built from a launch handle round-trips send/on over its transport', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  const client = await f.launch.cdpClient(handle)
  const events = []
  client.on('Page.loadEventFired', () => events.push('load'))
  const promise = client.send('Page.enable')
  const id = f.transport.sent.at(-1).id
  f.transport.emitMessage({ id, result: {} })
  await promise
  f.transport.emitMessage({ method: 'Page.loadEventFired', params: {} })
  assert.deepEqual(events, ['load'])
})

test('handle.close tears down the transport and kills the child', async () => {
  const f = launchFixture()
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  handle.close()
  assert.equal(f.transport.closed, true)
  assert.equal(f.spawns[0].killed, true)
})

test('launcher continues when the profile copy fails (best-effort seed)', async () => {
  const f = launchFixture({ copyProfile: async () => { throw new Error('locked') } })
  const handle = await f.launch.launcher({ id: 'a', url: 'https://x.com', browser: 'chrome' })
  assert.equal(handle.mode, 'pipe')
  assert.equal(f.spawns.length, 1)
})
