/**
 * OPT-IN live check of the Browser Hub against the REAL Chrome/Edge installed
 * on this machine. NOT part of any default test glob (no `.spec.js` suffix).
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   $env:BROWSER_HUB_LIVE=1
 *   node_modules\electron\dist\electron.exe src\test\integration\browser-hub-live.js [chrome|edge ...]
 *
 * Safety: every browser runs in a throw-away user-data-dir created under the OS
 * temp folder and deleted at the end; only about:blank and data: URLs are
 * opened (no network); nothing touches the user's real profile. Findings are
 * printed as JSON.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { createCdpLaunch, createPipeTransport, detectBrowserPath } = require('../../app/lib/cdp-launch')
const { createTabManager } = require('../../app/lib/cdp-tabs')
const { createPageDriver } = require('../../app/lib/cdp-ax')
const { createExtensionManager } = require('../../app/lib/cdp-extensions')

if (process.env.BROWSER_HUB_LIVE !== '1') {
  console.error('Set BROWSER_HUB_LIVE=1 to run the live browser checks')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anubis-hub-live-'))
const report = { startedAt: new Date().toISOString(), engines: {} }

function writeExtension (dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name,
    version: '1.0.0',
    background: { service_worker: 'sw.js' }
  }))
  fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("install", () => {})\n')
}

const PAGE = 'data:text/html,' + encodeURIComponent(
  '<title>hub-live</title><button id=b onclick="document.title=\'clicked\'">Go</button>' +
  '<select id=s><option value=a>A</option><option value=b>B</option></select>' +
  '<input id=f type=file><input id=t type=text aria-label=Name>' +
  '<a id=d href="data:text/plain,hello" download="x.txt">dl</a>'
)

async function step (out, name, fn) {
  const t = Date.now()
  try {
    const value = await fn()
    out[name] = { ok: true, ms: Date.now() - t, ...(value === undefined ? {} : { value }) }
  } catch (e) {
    out[name] = { ok: false, ms: Date.now() - t, error: String((e && e.message) || e).slice(0, 300) }
  }
}

async function launch (engine, { unsafe, headless = true } = {}) {
  const dir = path.join(root, engine + '-' + (unsafe ? 'unsafe' : 'plain') + '-' + Date.now())
  const { launchBrowser } = createCdpLaunch({
    spawn,
    fsExists: (p) => fs.existsSync(p),
    removeDir: (p) => fs.rmSync(p, { recursive: true, force: true }),
    resolveUserDataDir: () => path.join(root, 'unused'),
    resolveHubUserDataDir: () => dir,
    connectPipe: async (proc) => createPipeTransport(proc),
    connectPort: async () => { throw new Error('port transport disabled in live test') },
    readDevToolsEndpoint: async () => { throw new Error('port transport disabled in live test') },
    preferPipe: true,
    log: { warn () {}, info () {}, error () {} }
  })
  const handle = await launchBrowser({
    id: 'live_' + engine,
    browser: engine,
    profileMode: 'ephemeral',
    headless,
    url: 'about:blank',
    unsafeExtensionDebugging: !!unsafe
  })
  return handle
}

async function runEngine (engine) {
  const out = {}
  report.engines[engine] = out
  const exe = detectBrowserPath(engine)
  if (!exe) { out.installed = false; return }
  out.installed = true
  try {
    out.version = String(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8' })).trim()
  } catch {}

  // 1. loadUnpacked WITHOUT --enable-unsafe-extension-debugging (dev mode is off in a fresh profile)
  out.loadUnpackedNoFlag = {}
  let h = await launch(engine, { unsafe: false })
  try {
    const extDir = path.join(root, engine + '-ext-noflag')
    writeExtension(extDir, 'noflag')
    const mgr = createExtensionManager({ client: h.client, engine, resolveSource: () => extDir })
    await step(out.loadUnpackedNoFlag, 'result', async () => (await mgr.install({ source: { stagedId: 'x' } })).extension.extensionId)
  } finally { h.close() }
  await sleep(500)

  // 2. loadUnpacked WITH the flag, dev mode never enabled (fresh profile)
  h = await launch(engine, { unsafe: true })
  try {
    const client = h.client
    const extDir = path.join(root, engine + '-ext')
    writeExtension(extDir, 'live-ext')
    const mgr = createExtensionManager({ client, engine, resolveSource: () => extDir })
    out.loadUnpackedWithFlag = {}
    let id
    await step(out.loadUnpackedWithFlag, 'install', async () => { id = (await mgr.install({ source: { stagedId: 'x' } })).extension.extensionId; return id })
    await sleep(800)
    await step(out.loadUnpackedWithFlag, 'serviceWorkerTarget', async () => {
      const { targetInfos } = await client.send('Target.getTargets', {})
      return targetInfos.some((t) => String(t.url).startsWith('chrome-extension://' + id) || String(t.url).startsWith('extension://' + id))
    })
    await step(out.loadUnpackedWithFlag, 'list', async () => (await mgr.list()).extensions.length)
    if (id) {
      await step(out.loadUnpackedWithFlag, 'disable', async () => (await mgr.disable(id)).extension.enabled)
      await step(out.loadUnpackedWithFlag, 'enable', async () => (await mgr.enable(id)).extension.enabled)
      await step(out.loadUnpackedWithFlag, 'remove', async () => (await mgr.remove(id)).removed)
    }

    // 3. tabs
    const tabs = createTabManager({ client, limits: { maxTabsPerBrowser: 10 } })
    out.tabs = {}
    await tabs.init()
    let t1
    await step(out.tabs, 'newTab', async () => { t1 = (await tabs.newTab({ url: PAGE })).tab.tabId; return true })
    let t2
    await step(out.tabs, 'newTabBlank', async () => { t2 = (await tabs.newTab({ url: 'about:blank', activate: false })).tab.tabId; return true })
    await step(out.tabs, 'list', async () => tabs.list().tabs.length)
    await step(out.tabs, 'activate', async () => (await tabs.activate(t2)).tab.active)
    await step(out.tabs, 'gotoDataUrl', async () => (await tabs.goto(t2, 'data:text/html,<title>two</title>x', { waitUntil: 'load' })).title)
    await step(out.tabs, 'close', async () => (await tabs.close(t2)).closed)

    // 4. snapshot + actions
    out.page = {}
    const page = createPageDriver({ tabs })
    let snap
    await sleep(500)
    await step(out.page, 'snapshot', async () => {
      snap = await page.snapshot(t1, { interestingOnly: true })
      return { nodes: snap.nodes.length, roles: [...new Set(snap.nodes.map((n) => n.role))] }
    })
    const ref = (role) => snap && snap.nodes.find((n) => n.role === role)
    await step(out.page, 'clickByRef', async () => {
      await page.click(t1, { ref: ref('button').ref, snapshotId: snap.snapshotId })
      await sleep(150)
      return (await page.evaluate(t1, { expression: 'document.title' })).value
    })
    await step(out.page, 'clickByCoordinates', async () => {
      await page.evaluate(t1, { expression: 'document.title="reset"' })
      const box = (await page.evaluate(t1, { expression: 'JSON.stringify(document.getElementById("b").getBoundingClientRect())' })).value
      const r = JSON.parse(box)
      await page.click(t1, { x: r.x + r.width / 2, y: r.y + r.height / 2 })
      await sleep(150)
      return (await page.evaluate(t1, { expression: 'document.title' })).value
    })
    await step(out.page, 'select', async () => {
      const s = snap.nodes.find((n) => n.role === 'combobox')
      if (!s || !page.select) throw new Error('select not available')
      await page.select(t1, { ref: s.ref, snapshotId: snap.snapshotId, values: ['b'] })
      return (await page.evaluate(t1, { expression: 'document.getElementById("s").value' })).value
    })
    await step(out.page, 'upload', async () => {
      if (!page.upload) throw new Error('upload not available')
      const file = path.join(root, 'upload.txt')
      fs.writeFileSync(file, 'hello')
      await page.upload(t1, { selector: '#f', files: [file] })
      return (await page.evaluate(t1, { expression: 'document.getElementById("f").files.length' })).value
    })
    out.fetchGuard = {}
    await step(out.fetchGuard, 'dataUrlIntercepted', async () => {
      const sid = await tabs.ensureSession(t1)
      let seen = 0
      client.on('Fetch.requestPaused', (p) => { seen++; client.send('Fetch.continueRequest', { requestId: p.requestId }, sid).catch(() => {}) }, sid)
      await client.send('Fetch.enable', { patterns: [{ resourceType: 'Document' }] }, sid)
      await tabs.goto(t1, 'data:text/html,<title>fetch</title>', { waitUntil: 'load' })
      await client.send('Fetch.disable', {}, sid)
      return seen
    })
    out.downloads = {}
    await step(out.downloads, 'downloadEvents', async () => {
      const dl = path.join(root, 'dl-' + engine)
      fs.mkdirSync(dl, { recursive: true })
      const events = []
      client.on('Browser.downloadWillBegin', (p) => events.push(['begin', p.suggestedFilename]))
      client.on('Browser.downloadProgress', (p) => events.push([p.state]))
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true })
      await tabs.goto(t1, PAGE, { waitUntil: 'load' })
      await page.evaluate(t1, { expression: 'document.getElementById("d").click()' })
      await sleep(1200)
      return { events: events.slice(0, 4), files: fs.readdirSync(dl) }
    })
  } finally { h.close() }
}

async function main () {
  const wanted = process.argv.slice(2)
  const engines = wanted.length ? wanted : ['chrome', 'edge']
  try {
    for (const engine of engines) {
      try { await runEngine(engine) } catch (e) { report.engines[engine] = { ...(report.engines[engine] || {}), fatal: String((e && e.message) || e) } }
    }
  } finally {
    await sleep(800)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break } catch { await sleep(500) }
    }
    report.tempDirRemoved = !fs.existsSync(root)
    console.log(JSON.stringify(report, null, 2))
  }
}

main().then(() => process.exit(0))
