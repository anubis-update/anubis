const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@babel/parser')
const settingsModule = import('../../client/common/scanner-settings.mjs')

test('Scarab defaults match the reference and saved drafts retain only supported fields', async () => {
  const { SCARAB_DEFAULTS, SCARAB_SETTINGS_KEY, readScarabSettings } = await settingsModule
  const saved = {
    modulePath: 'D:\\Modules\\Scarab',
    scanPath: 'D:\\Apps',
    signState: 'any',
    imageType: 'x64',
    greenDllCount: 3,
    yellowExeSize: 60000,
    abuseCandidate: 'untrusted',
    directoryPermission: 123,
    greenExeSize: -1,
    yellowDllCount: 2.5
  }
  const { settings, error } = readScarabSettings({
    getItem: key => {
      assert.equal(key, SCARAB_SETTINGS_KEY)
      return JSON.stringify(saved)
    }
  })
  assert.equal(error, '')
  assert.equal(settings.modulePath, saved.modulePath)
  assert.equal(settings.scanPath, saved.scanPath)
  assert.equal(settings.imageType, 'x64')
  assert.equal(settings.signState, 'any')
  assert.equal(settings.greenDllCount, 3)
  assert.equal(settings.yellowExeSize, 60000)
  assert.equal(settings.abuseCandidate, 'all')
  assert.equal(settings.directoryPermission, 'any')
  assert.equal(settings.greenExeSize, 10240)
  assert.equal(settings.yellowDllCount, 5)
  assert.equal(SCARAB_DEFAULTS.signState, 'signed')
  assert.equal(SCARAB_DEFAULTS.greenDllCount, 2)
  assert.equal(SCARAB_DEFAULTS.yellowExeSize, 51200)
})

test('invalid or unavailable saved settings are reported rather than silently treated as a saved configuration', async () => {
  const { SCARAB_DEFAULTS, readScarabSettings } = await settingsModule
  for (const storage of [
    { getItem: () => '{invalid' },
    { getItem: () => '[]' },
    { getItem: () => 'null' },
    { getItem: () => { throw new Error('Storage disabled') } }
  ]) {
    const result = readScarabSettings(storage)
    assert.deepEqual(result.settings, SCARAB_DEFAULTS)
    assert.match(result.error, /Could not read saved Scarab settings:/)
  }
  assert.equal(readScarabSettings({ getItem: () => null }).error, '')
})

const findings = [
  { id: 'CVE-2026-1001', severity: 'critical', cvss: 9.8, knownExploited: true },
  { id: 'CVE-2026-1002', severity: 'high', cvss: 7.5, knownExploited: false },
  { id: 'CVE-2026-1003', severity: 'high', cvss: null, knownExploited: true },
  { id: 'CVE-2026-1004', severity: 'low', cvss: 2.5, knownExploited: true }
]

test('Aegis filters preserve high-risk scope and never mutate stored results', async () => {
  const { filterCveFindings } = await settingsModule
  const before = JSON.stringify(findings)
  const ids = filters => filterCveFindings(findings, filters).map(row => row.id)
  assert.deepEqual(ids({}), findings.slice(0, 3).map(row => row.id))
  assert.deepEqual(ids({ type: 'kev' }), [findings[0].id, findings[2].id])
  assert.deepEqual(ids({ type: 'other' }), [findings[1].id])
  assert.deepEqual(ids({ severity: 'critical' }), [findings[0].id])
  assert.deepEqual(ids({ minCvss: 7 }), [findings[0].id, findings[1].id])
  assert.deepEqual(ids({ minCvss: 10 }), [])
  assert.deepEqual(ids({ type: 'kev', severity: 'high', minCvss: 8 }), [])
  assert.equal(JSON.stringify(findings), before)
})

test('Aegis excludes unverified candidates unless requested and distinguishes unknown KEV status', async () => {
  const { filterCveFindings } = await settingsModule
  const records = [
    { ...findings[0], candidate: true },
    { ...findings[1], candidate: false },
    { ...findings[2], candidate: false, knownExploited: null }
  ]
  assert.deepEqual(filterCveFindings(records, { includeCandidates: false }).map(row => row.id), [records[1].id, records[2].id])
  assert.equal(filterCveFindings(records, { includeCandidates: true }).length, 3)
  assert.deepEqual(filterCveFindings(records, { type: 'other' }).map(row => row.id), [records[1].id])
})

async function harness (filename, { scan = null, storage, isWebApp = true, openDialog } = {}) {
  const { transformSync } = await import('rolldown/experimental')
  const file = path.resolve(__dirname, '../../client/components/sidebar', filename)
  let code = transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'automatic' } }).code
  const ast = parse(code, { sourceType: 'module' })
  const edits = ast.program.body.flatMap(node => {
    if (node.type === 'ImportDeclaration') {
      return [{
        start: node.start,
        end: node.end,
        text: node.specifiers.map(spec => `const ${spec.local.name} = require(${JSON.stringify(node.source.value)})[${JSON.stringify(spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.name)}];`).join('\n')
      }]
    }
    if (node.type === 'ExportDefaultDeclaration') return [{ start: node.start, end: node.declaration.start, text: 'module.exports = ' }]
    return []
  })
  for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end)
  const hooks = []
  let hookIndex = 0
  const effects = []
  const calls = []
  const saved = new Map()
  let modulePaths = { jsModulePath: 'C:\\ProgramData\\Modules\\cve-scanner-js', pythonModulePath: 'C:\\ProgramData\\Modules\\cve-scanner-py', revision: 0 }
  const dependencies = {
    react: {
      useState: initial => {
        const index = hookIndex++
        if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
        return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
      },
      useEffect: effect => effects.push(effect)
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    antd: {
      Alert: 'Alert',
      Button: 'Button',
      Checkbox: 'Checkbox',
      Col: 'Col',
      Divider: 'Divider',
      Input: 'Input',
      InputNumber: 'InputNumber',
      Modal: 'Modal',
      Progress: 'Progress',
      Row: 'Row',
      Select: 'Select',
      Space: 'Space',
      Table: 'Table',
      Tag: 'Tag',
      Tooltip: 'Tooltip',
      Form: Object.assign(() => {}, { Item: 'FormItem' }),
      Radio: Object.assign(() => {}, { Group: 'RadioGroup' }),
      Typography: { Text: 'Text', Title: 'Title', Link: 'Link' }
    },
    'manate/react': { auto: value => value },
    './module-page': { default: 'ModulePage' },
    '../setting-panel/setting-wrap': { default: 'SettingWrap' },
    '../common/modal': { default: 'Modal' },
    './module-path-field': { default: 'ModulePathField' },
    '../../common/scanner-settings.mjs': await settingsModule,
    '../web/hub-client': {
      default: {
        localCveScanner: async (action, payload) => {
          calls.push({ action, payload })
          if (action === 'settings') return modulePaths
          if (action === 'configure') {
            modulePaths = { ...payload, revision: payload.revision + 1 }
            return modulePaths
          }
          return scan
        }
      }
    }
  }
  const context = {
    module: { exports: {} },
    window: {
      store: { innerWidth: 1440, hasNativeTitleStrip: false },
      et: { isWebApp },
      api: { openDialog },
      localStorage: storage || { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) }
    },
    setTimeout,
    clearTimeout,
    console,
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(code, context, { filename })
  return {
    calls,
    saved,
    render: props => {
      hookIndex = 0
      return context.module.exports(props || {})
    },
    flushEffects: async () => {
      for (const effect of effects.splice(0)) effect()
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

function nodes (tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  if (!tree || typeof tree !== 'object' || !tree.props) return []
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)]
}
const named = (tree, type) => nodes(tree, node => node.type === type)
const button = (tree, text) => nodes(tree, node => node.type === 'Button' && node.props.children === text)[0]

test('Scarab renders all reference controls and empty results without any execution handler', async () => {
  const { SCARAB_DEFAULTS, SCARAB_SETTINGS_KEY } = await settingsModule
  const h = await harness('dll-scanner-page.jsx')
  let tree = h.render()
  assert.equal(named(tree, 'RadioGroup').length, 4)
  assert.equal(named(tree, 'InputNumber').length, 4)
  assert.deepEqual(named(tree, 'ModulePathField').map(node => node.props.value),
    [SCARAB_DEFAULTS.modulePath, SCARAB_DEFAULTS.scanPath])
  for (const label of ['Start scan', 'Cancel', 'Export...']) {
    assert.equal(button(tree, label).props.disabled, true)
    assert.equal(button(tree, label).props.onClick, undefined)
  }
  assert.equal(named(tree, 'Table')[0].props.dataSource.length, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(named(tree, 'ModulePage')[0].props.name, 'DLL Scanner')
  await h.flushEffects()
  assert.deepEqual(JSON.parse(h.saved.get(SCARAB_SETTINGS_KEY)), SCARAB_DEFAULTS)
  button(tree, 'About').props.onClick()
  tree = h.render()
  assert.equal(named(tree, 'Modal')[0].props.open, true)
  named(tree, 'InputNumber')[2].props.onChange(12)
  tree = h.render()
  assert.ok(named(tree, 'Text').some(node => node.props.children?.includes?.(12)))
})

test('Scarab edits survive page remount and persistence failures appear in the page', async () => {
  const saved = new Map()
  const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) }
  const h = await harness('dll-scanner-page.jsx', { storage })
  named(h.render(), 'ModulePathField')[0].props.onChange('D:\\Scarab')
  h.render()
  await h.flushEffects()
  const remount = await harness('dll-scanner-page.jsx', { storage })
  assert.equal(named(remount.render(), 'ModulePathField')[0].props.value, 'D:\\Scarab')
  const failed = await harness('dll-scanner-page.jsx', {
    storage: { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } }
  })
  failed.render()
  await failed.flushEffects()
  assert.ok(named(failed.render(), 'Alert').some(node => /Quota exceeded/.test(node.props.title)))
})

test('WEB Browse is disabled; Desktop Browse chooses a target folder and reports errors', async () => {
  const web = await harness('module-path-field.jsx')
  assert.equal(named(web.render({ label: 'Folder' }), 'Button')[0].props.disabled, true)
  const changes = []
  const desktop = await harness('module-path-field.jsx', {
    isWebApp: false,
    openDialog: async options => {
      assert.equal(options.properties[0], 'openDirectory')
      return ['D:\\Target']
    }
  })
  const props = { label: 'Folder', value: 'C:\\Apps', onChange: value => changes.push(value) }
  await named(desktop.render(props), 'Button')[0].props.onClick()
  assert.deepEqual(changes, ['D:\\Target'])
  const failed = await harness('module-path-field.jsx', { isWebApp: false, openDialog: async () => { throw new Error('Dialog unavailable') } })
  await named(failed.render(props), 'Button')[0].props.onClick()
  assert.match(named(failed.render(props), 'Alert')[0].props.title, /Dialog unavailable/)
})

test('Aegis filters only the displayed result and preserves existing start/cancel transport', async () => {
  const scan = {
    runId: 'fixture',
    state: 'done',
    startedAt: '2026-11-04T00:00:00Z',
    findings,
    scanners: { js: { state: 'done' }, python: { state: 'done' } }
  }
  const h = await harness('cve-scanner-page.jsx', { scan })
  h.render()
  await h.flushEffects()
  let tree = h.render()
  assert.equal(named(tree, 'ModulePage')[0].props.name, 'CVE Scanner')
  assert.equal(named(tree, 'Table')[0].props.dataSource.length, 3)
  named(tree, 'Select')[0].props.onChange('kev')
  tree = h.render()
  assert.equal(named(tree, 'Table')[0].props.dataSource.length, 2)
  named(tree, 'InputNumber')[0].props.onChange(9)
  tree = h.render()
  assert.equal(named(tree, 'Table')[0].props.dataSource.length, 1)
  assert.equal(h.calls.length, 2)
  button(tree, 'Reset filters').props.onClick()
  assert.equal(named(h.render(), 'Table')[0].props.dataSource.length, 3)
  named(tree, 'ModulePathField')[0].props.onChange(' D:\\JS ')
  assert.equal(button(h.render(), 'Start both scans').props.disabled, true)
  await button(h.render(), 'Save module paths').props.onClick()
  assert.equal(h.calls.at(-1).action, 'configure')
  assert.equal(h.calls.at(-1).payload.jsModulePath, 'D:\\JS')
  named(h.render(), 'Checkbox')[1].props.onChange({ target: { checked: true } })
  await button(h.render(), 'Start both scans').props.onClick()
  assert.equal(h.calls.at(-1).action, 'start')
  assert.equal(h.calls.at(-1).payload.confirmed, true)

  const active = await harness('cve-scanner-page.jsx', { scan: { ...scan, state: 'running' } })
  active.render()
  await active.flushEffects()
  await button(active.render(), 'Cancel scan').props.onClick()
  assert.equal(active.calls.at(-1).action, 'cancel')
  assert.equal(active.calls.at(-1).payload.runId, 'fixture')
})

test('modules render full workspace sections, not settings drawers, without replacing the application theme', async () => {
  const h = await harness('module-page.jsx')
  let closed = false
  const tree = h.render({ title: 'Anubis Scarab', name: 'DLL Scanner', onClose: () => { closed = true }, children: 'Settings' })
  assert.equal(named(tree, 'SettingWrap').length, 0)
  assert.equal(tree.type, 'main')
  assert.equal(tree.props['aria-label'], 'DLL Scanner')
  button(tree, 'Back to workspace').props.onClick()
  assert.equal(closed, true)
  assert.ok(nodes(tree, node => node.props.className === 'module-settings-content pd2 overscroll-y').length)
  for (const file of ['dll-scanner-page.jsx', 'cve-scanner-page.jsx', 'module-page.jsx']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../client/components/sidebar', file), 'utf8')
    assert.doesNotMatch(source, /ConfigProvider|module-pages\.styl|aegis-page|module-page-icon/)
  }
  const styles = fs.readFileSync(path.resolve(__dirname, '../../client/components/sidebar/module-page.styl'), 'utf8')
  assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|position fixed|z-index|border-radius|font-family/i)
  const main = fs.readFileSync(path.resolve(__dirname, '../../client/components/main/main.jsx'), 'utf8')
  assert.match(main, /className='terminal-workspace' hidden=\{moduleOpen\}/)
  assert.match(main, /<Layout store=\{store\} \/>/)
})
