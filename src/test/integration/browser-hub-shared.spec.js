const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createCdpLaunch, createPipeTransport, detectBrowserPath, copyProfileTolerant } = require('../../app/lib/cdp-launch')
const { createCdpBrowser } = require('../../app/lib/cdp-browser')
const { createBrowserApi } = require('../../app/lib/browser-api')
const { createBrowserHubController } = require('../../app/lib/browser-api/hub-controller')
const { createTokenStore } = require('../../app/lib/browser-api/v1-api')
const { createBrowserRpc } = require('../../app/lib/managed-browser-rpc')
const { createStaging } = require('../../app/lib/browser-api/staging')
const { createExtensionStateStore } = require('../../app/lib/cdp-extensions')

for (const engine of ['chrome', 'edge']) {
  test(`real ${engine}: Browser engine and Web Hub share process, tabs and screencast`, {
    skip: !process.env.ANUBIS_LIVE_BROWSER_TEST,
    timeout: 90000
  }, async (t) => {
    assert.ok(detectBrowserPath(engine, { fsExists: fs.existsSync }), `${engine} must be installed`)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-shared-test-'))
    const source = path.join(root, 'source')
    fs.mkdirSync(path.join(source, 'Profile 1'), { recursive: true })
    fs.writeFileSync(path.join(source, 'Profile 1', 'Preferences'), JSON.stringify({ profile: { name: 'Shared integration profile' } }))
    fs.writeFileSync(path.join(source, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Shared integration profile' } } } }))
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(`<title>${req.url === '/two' ? 'SECOND' : 'FIRST'}</title><h1>${req.url}</h1><input id="field" autofocus>`)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const launches = []
    const launch = createCdpLaunch({
      spawn: (...args) => {
        const child = spawn(...args)
        if (process.env.ANUBIS_LIVE_DEBUG) child.on('exit', (code, signal) => console.log(engine, 'exit', code, signal))
        launches.push(child)
        return child
      },
      fsExists: fs.existsSync,
      resolveSourceProfile: () => source,
      copyProfile: copyProfileTolerant,
      resolveLaunchOptions: engine => api.sharedLaunchOptions(engine),
      resolveUserDataDir: () => path.join(root, 'profile'),
      connectPipe: async child => createPipeTransport(child)
    })
    const frames = []
    const events = []
    const view = createCdpBrowser({
      launcher: launch.launcher,
      cdpClient: launch.cdpClient,
      onFrame: (id, data) => frames.push({ id, size: data.length }),
      onEvent: (id, event) => events.push({ id, ...event }),
      onOpened: ({ id, handle, targetId }) => api.hub.engine(engine).attach({
        ...handle, close: () => view.closeBrowser(handle.client)
      }, { sessionId: id, targetId }),
      onClosed: ({ id }) => api.hub.engine(engine).detachSession(id)
    })
    const api = createBrowserApi({
      engines: [engine],
      launchBrowser: async () => { throw new Error('Hub must not launch another browser') },
      onActiveTarget: (client, targetId) => view.activateTarget(client, targetId),
      auditDir: path.join(root, 'audit'),
      resolveSourceDir: () => source,
      staging: createStaging({ root: path.join(root, 'staging') }),
      extensionStateForHandle: handle => createExtensionStateStore({
        root: path.join(root, 'extensions'),
        userDataDir: handle.userDataDir,
        profileDirectory: handle.profileDirectory
      }),
      // The test server is deliberately loopback; production URL policy is unchanged.
      policy: { ...require('../../app/lib/browser-api/policy-engine').DEFAULT_POLICY, domains: { blockPrivateNetworks: false } }
    })
    const controller = createBrowserHubController({ api, tokens: createTokenStore() })
    const rpc = createBrowserRpc({ functions: { browserHub: (...args) => controller.handle(...args) } })
    const command = async (command, browserId, params = {}, tabId) => {
      if (process.env.ANUBIS_LIVE_DEBUG) console.log(engine, command, params)
      const envelope = await rpc('browserHub', ['command.execute', { command, browserId, params, ...(tabId ? { tabId } : {}) }])
      assert.equal(envelope.ok, true, JSON.stringify(envelope.error))
      assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error))
      return envelope.result.result
    }
    const until = async (predicate) => {
      const end = Date.now() + 15000
      while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(predicate(), 'Expected browser event/frame did not arrive')
    }
    t.after(async () => {
      view.disposeAll()
      controller.dispose()
      api.shutdown()
      for (const child of launches) {
        if (child.exitCode === null) {
          child.kill()
          await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref() })
        }
      }
      await new Promise(resolve => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })
    const profile = api.catalog.enumerate(engine).profiles[0]
    api.catalog.select(engine, profile.profileId)
    await view.open({ id: 'web-session-one', engine, url: origin + '/one', width: 900, height: 600 })
    const status = (await rpc('browserHub', ['status'])).result
    assert.equal(status.browsers.length, 1)
    const browserId = status.browsers[0].browserId
    assert.deepEqual(status.browsers[0].sessionIds, ['web-session-one'])
    assert.equal(status.browsers[0].profileId, profile.profileId)
    assert.ok(launches[0].spawnargs.includes('--profile-directory=Profile 1'))
    assert.ok(!launches[0].spawnargs.includes('--enable-unsafe-extension-debugging'))
    assert.equal(launches.length, 1)
    const first = (await command('tab.list', browserId, { includeInternal: true })).tabs.find(tab => tab.url === origin + '/one')
    assert.ok(first)
    await until(() => frames.length > 0)
    const raw = view._sessions.get('web-session-one').handle.client
    const versionTarget = await raw.send('Target.createTarget', { url: `${engine}://version` })
    try {
      const { sessionId } = await raw.send('Target.attachToTarget', { targetId: versionTarget.targetId, flatten: true })
      let actualProfile
      for (let attempt = 0; attempt < 30 && !actualProfile; attempt++) {
        const result = await raw.send('Runtime.evaluate', {
          expression: "document.querySelector('#profile_path')?.textContent", returnByValue: true
        }, sessionId)
        actualProfile = result.result.value
        if (!actualProfile) await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.equal(actualProfile, path.join(root, 'profile', 'Profile 1'), 'Browser must actually use the selected profile, not only report its id')
    } finally { await raw.send('Target.closeTarget', { targetId: versionTarget.targetId }) }
    const second = (await command('tab.new', browserId, { url: origin + '/two' })).tab
    await until(() => events.some(event => event.t === 'nav' && event.url === origin + '/two'))
    let count = frames.length
    await command('tab.activate', browserId, {}, first.tabId)
    await until(() => frames.length > count && events[events.length - 1])
    assert.equal(view._sessions.get('web-session-one').url, origin + '/one')
    await command('tab.activate', browserId, {}, second.tabId)
    assert.equal(view._sessions.get('web-session-one').url, origin + '/two')
    await view._sessions.get('web-session-one').client.send('Runtime.evaluate', { expression: "document.querySelector('#field').focus()" })
    await view.input({ id: 'web-session-one', t: 'key', kind: 'char', key: 'Z' })
    const input = await view._sessions.get('web-session-one').client.send('Runtime.evaluate', {
      expression: "document.querySelector('#field').value", returnByValue: true
    })
    assert.equal(input.result.value, 'Z', 'Remote input must reach the newly selected tab')
    await command('tab.goto', browserId, { url: origin + '/navigated', waitUntil: 'load' }, second.tabId)
    await until(() => view._sessions.get('web-session-one').url === origin + '/navigated')
    const shot = await command('page.screenshot', browserId, {}, second.tabId)
    assert.ok(shot.data.length > 1000)
    await command('tab.close', browserId, {}, second.tabId)
    assert.equal(view._sessions.get('web-session-one').url, origin + '/one')
    assert.equal((await command('devMode.set', browserId, { enabled: true })).enabled, true)
    assert.equal((await command('devMode.set', browserId, { enabled: false })).enabled, false)
    await view.open({ id: 'web-session-two', engine, url: origin + '/two' })
    assert.equal(launches.length, 1, 'Second view must reuse the same browser process')
    assert.equal(api.hub.allBrowsers().length, 1)
    assert.equal(api.hub.allBrowsers()[0].sessionIds.length, 2)
    view.close({ id: 'web-session-one' })
    assert.deepEqual(api.hub.allBrowsers()[0].sessionIds, ['web-session-two'])
    count = frames.length
    await command('tab.new', browserId, { url: origin + '/one' })
    await until(() => frames.length > count)
    await command('browser.close', browserId)
    assert.equal(view.count(), 0)
    assert.deepEqual(api.hub.allBrowsers(), [])
    const policy = api.policy.snapshot()
    api.policy.setPolicy({ ...policy, extensions: { allowInstall: true } })
    await view.open({ id: 'last-view', engine, url: origin + '/one' })
    assert.ok(launches[1].spawnargs.includes('--enable-unsafe-extension-debugging'))
    let lastBrowser = api.hub.allBrowsers()[0].browserId
    let lastTab = (await command('tab.list', lastBrowser)).tabs[0].tabId
    const extensionDir = path.join(root, 'extension')
    fs.mkdirSync(extensionDir)
    fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Anubis shared process integration',
      version: '1.0',
      permissions: ['storage'],
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_end' }]
    }))
    fs.writeFileSync(path.join(extensionDir, 'content.js'), "document.documentElement.setAttribute('data-anubis-extension', 'active')")
    fs.writeFileSync(path.join(extensionDir, 'state.html'), '<title>Extension state</title>')
    const external = await view._sessions.get('last-view').handle.client.send('Extensions.loadUnpacked', { path: extensionDir })
    const externalInfo = (await command('extension.list', lastBrowser)).extensions.find(e => e.extensionId === external.id)
    assert.ok(externalInfo, 'Catalog must include extensions installed outside the Hub manager')
    assert.equal(externalInfo.enabled, true)
    await command('extension.disable', lastBrowser, { extensionId: external.id })
    assert.equal((await command('extension.list', lastBrowser)).extensions.find(e => e.extensionId === external.id).enabled, false)
    await command('extension.remove', lastBrowser, { extensionId: external.id })
    const staged = api.staging.importPath(extensionDir)
    const installed = await command('extension.install', lastBrowser, { source: { type: 'unpacked', stagedId: staged.stagedId } })
    const extensionId = installed.extension.extensionId
    const extensionState = async (write) => {
      const client = view._sessions.get('last-view').handle.client
      const { targetId } = await client.send('Target.createTarget', { url: `chrome-extension://${extensionId}/state.html`, background: true })
      try {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
        let value
        for (let attempt = 0; attempt < 30 && value === undefined; attempt++) {
          const result = await client.send('Runtime.evaluate', {
            expression: `typeof chrome.storage === 'undefined' ? undefined : (async () => { ${write ? "await chrome.storage.local.set({anubisState:'preserved'});" : ''} return (await chrome.storage.local.get('anubisState')).anubisState })()`,
            awaitPromise: true,
            returnByValue: true
          }, sessionId)
          value = result.result.value
          if (value === undefined) await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert.equal(value, 'preserved', 'Disabling must preserve extension-owned data')
      } finally { await client.send('Target.closeTarget', { targetId }) }
    }
    const assertInjection = async (expected) => {
      await command('tab.goto', lastBrowser, { url: origin + '/extension-check', waitUntil: 'load' }, lastTab)
      const result = await view._sessions.get('last-view').client.send('Runtime.evaluate', {
        expression: "document.documentElement.getAttribute('data-anubis-extension')", returnByValue: true
      })
      assert.equal(result.result.value, expected)
    }
    await assertInjection('active')
    await extensionState(true)
    await command('extension.disable', lastBrowser, { extensionId })
    await assertInjection(null)
    await view._sessions.get('last-view').handle.client.send('Browser.close')
    await until(() => view.count() === 0)
    await view.open({ id: 'last-view', engine, url: origin + '/one' })
    lastBrowser = api.hub.allBrowsers()[0].browserId
    lastTab = (await command('tab.list', lastBrowser)).tabs.find(tab => tab.url === origin + '/one').tabId
    const restored = await command('extension.list', lastBrowser)
    const persisted = restored.extensions.find(e => e.extensionId === extensionId)
    assert.ok(persisted, 'Native list must find extensions after browser and manager restart')
    assert.equal(persisted.enabled, false)
    await command('extension.enable', lastBrowser, { extensionId })
    await assertInjection('active')
    await extensionState(false)
    await view._sessions.get('last-view').handle.client.send('Browser.close')
    await until(() => view.count() === 0)
    await view.open({ id: 'last-view', engine, url: origin + '/one' })
    lastBrowser = api.hub.allBrowsers()[0].browserId
    lastTab = (await command('tab.list', lastBrowser)).tabs.find(tab => tab.url === origin + '/one').tabId
    assert.equal((await command('extension.list', lastBrowser)).extensions.find(e => e.extensionId === extensionId).enabled, true)
    await assertInjection('active')
    await extensionState(false)
    await command('extension.disable', lastBrowser, { extensionId })
    await command('extension.remove', lastBrowser, { extensionId })
    await assertInjection(null)
    assert.deepEqual((await command('extension.list', lastBrowser)).extensions, [])
    view.close({ id: 'last-view' })
    assert.equal(view.count(), 0)
    assert.deepEqual(api.hub.allBrowsers(), [], 'Closing the last view must unregister the adopted browser')
  })
}
