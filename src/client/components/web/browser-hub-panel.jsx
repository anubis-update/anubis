import React, { useState, useEffect, useCallback, useContext, createContext } from 'react'
import { Tabs, Button, Space, Table, Input, Switch, Typography, Alert, Select, Tag, Modal } from 'antd'
import { notification } from '../common/notification'
import { handleErr } from '../../common/fetch'
import hub from './hub-client'
import { useGuardedCall } from './hub-confirm'
import {
  DEFAULT_DENY,
  EFFECTS,
  effectFor,
  setRule,
  validatePolicy
} from './hub-policy'

const { Text, Paragraph } = Typography

// Shared state: which running browser the Tabs / Extensions / History tabs act on.
const HubCtx = createContext({ browserId: null, engine: null, profileId: null, setProfileId: () => {}, reloadStatus: () => {} })

function fail (e) {
  handleErr({ message: e.message })
}

// Loads data through the hub adapter; errors surface via handleErr.
function useHubData (load, deps = []) {
  const [data, setData] = useState(null)
  const reload = useCallback(async () => {
    try {
      setData(await load())
    } catch (e) { fail(e) }
  }, deps)
  useEffect(() => { reload() }, [reload])
  return [data, reload]
}

function useExec () {
  const { browserId } = useContext(HubCtx)
  return useCallback((command, params, extra) => hub.exec(command, params, { browserId, ...extra }), [browserId])
}

function NeedBrowser ({ children }) {
  const { browserId } = useContext(HubCtx)
  if (!browserId) return <Alert type='info' showIcon message='Select Chrome or Edge in Browser engine to manage its tabs here, or launch an additional browser above.' />
  return children
}

function ProfilesTab () {
  const { profileId, setProfileId, engine } = useContext(HubCtx)
  const [data] = useHubData(() => hub.exec('profile.list', engine === 'chrome' || engine === 'edge' ? { engine } : {}), [engine])
  const select = async (id) => {
    try {
      await hub.exec('profile.select', { profileId: id })
      setProfileId(id)
      notification.info({ message: 'Profile saved for the next browser launch. Close all views of this engine before reopening it; existing tabs are unchanged.' })
    } catch (e) { fail(e) }
  }
  return (
    <Table
      size='small'
      rowKey='profileId'
      pagination={false}
      dataSource={(data && data.profiles) || []}
      columns={[
        { title: 'Profile', dataIndex: 'name' },
        { title: 'Engine', dataIndex: 'engine' },
        { title: 'Account', dataIndex: 'email' },
        { title: 'State', render: (_, r) => r.inUse ? <Tag color='orange'>in use</Tag> : (profileId === r.profileId ? <Tag color='green'>selected</Tag> : null) },
        { title: '', render: (_, r) => <Button size='small' disabled={profileId === r.profileId} onClick={() => select(r.profileId)}>Use on next launch</Button> }
      ]}
    />
  )
}

function TabsTab () {
  const exec = useExec()
  const { browserId } = useContext(HubCtx)
  const [data, reload] = useHubData(() => browserId ? exec('tab.list', { includeInternal: true }) : Promise.resolve(null), [browserId])
  useEffect(() => hub.onTabChange(browserId, reload, fail), [browserId, reload])
  const [url, setUrl] = useState('')
  const act = async (command, params, extra) => {
    try {
      await exec(command, params, extra)
      reload()
    } catch (e) { fail(e) }
  }
  const open = () => { act('tab.new', url ? { url } : {}); setUrl('') }
  return (
    <NeedBrowser>
      <Space direction='vertical' style={{ width: '100%' }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={url} placeholder='https://' onChange={e => setUrl(e.target.value)} onPressEnter={open} />
          <Button type='primary' onClick={open}>Open tab</Button>
        </Space.Compact>
        <Table
          size='small'
          rowKey='tabId'
          pagination={false}
          dataSource={(data && data.tabs) || []}
          columns={[
            { title: 'Title', dataIndex: 'title', ellipsis: true },
            { title: 'URL', dataIndex: 'url', ellipsis: true },
            {
              title: '',
              render: (_, r) => (
                <Space>
                  <Button size='small' disabled={r.active} onClick={() => act('tab.activate', {}, { tabId: r.tabId })}>Switch</Button>
                  <Button size='small' danger onClick={() => act('tab.close', {}, { tabId: r.tabId })}>Close</Button>
                </Space>
              )
            }
          ]}
        />
      </Space>
    </NeedBrowser>
  )
}

function ExtensionsTab () {
  const exec = useExec()
  const { browserId } = useContext(HubCtx)
  const [data, reload] = useHubData(() => browserId ? exec('extension.list', {}) : Promise.resolve(null), [browserId])
  const [path, setPath] = useState('')
  const [devMode, setDevMode] = useState(false)
  useEffect(() => {
    if (data && typeof data.developerMode === 'boolean') setDevMode(data.developerMode)
  }, [data])
  const [run] = useGuardedCall(exec)
  const act = async (command, params, detail) => {
    try {
      const res = await run(command, params, detail)
      if (res && res.restartRequired) notification.warning({ message: 'Restart the browser for this change to take effect' })
      reload()
      return res
    } catch (e) { fail(e) }
  }
  const setDev = async (enabled) => {
    const res = await act('devMode.set', { enabled })
    if (res) setDevMode(!!res.enabled)
  }
  const install = async () => {
    const p = path.trim()
    try {
      // The user-typed folder is copied into the backend staging area first;
      // install only ever receives the opaque stagedId.
      const staged = await hub.stagingImport(p)
      await act('extension.install', { source: { type: 'unpacked', stagedId: staged.stagedId } }, p)
      setPath('')
    } catch (e) { fail(e) }
  }
  return (
    <NeedBrowser>
      <Space direction='vertical' style={{ width: '100%' }}>
        <Button size='small' onClick={reload}>Refresh extensions</Button>
        <Space>
          <Text>Developer mode</Text>
          <Switch checked={devMode} onChange={setDev} />
        </Space>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={path} placeholder='Path to unpacked MV3 extension folder' onChange={e => setPath(e.target.value)} />
          <Button type='primary' disabled={!path.trim()} onClick={install}>Install unpacked</Button>
        </Space.Compact>
        <Table
          size='small'
          rowKey='extensionId'
          pagination={false}
          dataSource={(data && data.extensions) || []}
          columns={[
            { title: 'Name', dataIndex: 'name' },
            { title: 'Version', dataIndex: 'version' },
            { title: 'Type', dataIndex: 'installType' },
            { title: 'State', render: (_, r) => r.installed === false ? <Tag>saved, not loaded</Tag> : null },
            {
              title: 'Enabled',
              render: (_, r) => <Switch checked={!!r.enabled} disabled={r.mayModify === false} onChange={v => act(v ? 'extension.enable' : 'extension.disable', { extensionId: r.extensionId })} />
            },
            { title: '', render: (_, r) => <Button size='small' danger disabled={r.mayRemove === false} title={r.mayRemove === false ? 'Managed or store extension: use the native browser settings' : undefined} onClick={() => act('extension.remove', { extensionId: r.extensionId }, r.name)}>Remove</Button> }
          ]}
        />
      </Space>
    </NeedBrowser>
  )
}

function HistoryTab () {
  const exec = useExec()
  const { browserId } = useContext(HubCtx)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [run] = useGuardedCall(exec)
  const search = useCallback(async () => {
    if (!browserId) return
    try {
      const res = query.trim()
        ? await exec('history.search', { query: query.trim() })
        : await exec('history.list', {})
      setItems(res.entries || [])
    } catch (e) { fail(e) }
  }, [query, exec, browserId])
  useEffect(() => { search() }, [browserId])
  const clear = async () => {
    try {
      const res = await run('history.clear', {})
      if (res && res.cleared) setItems([])
    } catch (e) { fail(e) }
  }
  return (
    <NeedBrowser>
      <Space direction='vertical' style={{ width: '100%' }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input.Search value={query} placeholder='Search history' onChange={e => setQuery(e.target.value)} onSearch={search} enterButton />
        </Space.Compact>
        <Table
          size='small'
          rowKey={(r, i) => r.url + i}
          pagination={{ pageSize: 20 }}
          dataSource={items}
          columns={[
            { title: 'Title', dataIndex: 'title', ellipsis: true },
            { title: 'URL', dataIndex: 'url', ellipsis: true },
            { title: 'Visits', dataIndex: 'visitCount', width: 70 },
            { title: 'Last visit', dataIndex: 'lastVisitTime', width: 190 }
          ]}
        />
        <Button danger onClick={clear}>Clear history</Button>
      </Space>
    </NeedBrowser>
  )
}

function PasswordFiles ({ browserId, onActive }) {
  const [passphrase, setPassphrase] = useState('')
  const [file, setFile] = useState(null)
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [transportError, setTransportError] = useState('')
  const active = job && !['idle', 'succeeded', 'failed', 'cancelled'].includes(job.state)
  useEffect(() => { onActive(!!active); return () => onActive(false) }, [active, onActive])
  useEffect(() => {
    let stopped = false
    let timer
    const poll = async () => {
      try {
        const status = await hub.ipc('passwords.transferStatus', {})
        if (!stopped) { setJob(status); setTransportError('') }
      } catch (e) { if (!stopped) setTransportError(e.message) }
      if (!stopped) timer = setTimeout(poll, 1500)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])
  const start = kind => Modal.confirm({
    title: kind === 'export' ? 'Export passwords using the native browser?' : 'Import passwords using the native browser?',
    content: 'Continue only for accounts you are authorized to manage. The native browser controls the operation. Export may require the Windows account owner to approve on the device desktop. Anubis does not enter OS passwords or bypass approval. Only an encrypted file is transferred; keep its passphrase separately. Current native controls require an English Chrome or Edge UI.',
    okText: kind === 'export' ? 'Start native export' : 'Start native import',
    onOk: async () => {
      setBusy(true)
      setError('')
      try {
        const payload = { browserId, confirmed: true, passphrase }
        if (kind === 'import') {
          if (!file || file.size > 3 * 1024 * 1024) throw new Error('Select an encrypted password file smaller than 3 MiB')
          payload.artifact = JSON.parse(await file.text())
        }
        setJob(await hub.ipc('passwords.' + kind + 'File', payload))
      } catch (e) { setError(e.message) } finally { setPassphrase(''); setBusy(false) }
    }
  })
  const download = async () => {
    setBusy(true)
    try {
      const { artifact } = await hub.ipc('passwords.transferResult', { jobId: job.jobId })
      const url = URL.createObjectURL(new Blob([JSON.stringify(artifact)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'anubis-passwords-encrypted.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const cancel = async () => {
    setBusy(true)
    try { setJob(await hub.ipc('passwords.cancelTransfer', { jobId: job.jobId })) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Alert type='warning' showIcon message='Native password file transfer' description='Uses browser-native CSV import/export and Windows approval, never credential database decryption. Native dialogs and Windows Security are outside the streamed page. The Windows owner may need to approve or cancel directly on the device. Plaintext CSV remains in a restricted device directory only during the operation. Encrypted results expire after five minutes; interrupted transfers are not resumed.' />
      <Input.Password aria-label='Password file passphrase' autoComplete='new-password' placeholder='Password file passphrase (at least 12 characters)' value={passphrase} onChange={e => setPassphrase(e.target.value)} />
      <input aria-label='Encrypted password file' type='file' accept='.json,application/json' onChange={e => setFile(e.target.files[0] || null)} />
      <Space wrap>
        <Button disabled={busy || active || passphrase.length < 12} onClick={() => start('export')}>Export password file</Button>
        <Button disabled={busy || active || !file || passphrase.length < 12} onClick={() => start('import')}>Import password file</Button>
        {active && <Button disabled={busy || ['cancelling', 'waiting_for_windows_dismissal'].includes(job.state)} onClick={cancel}>Cancel password transfer</Button>}
        {job && job.artifactReady && <Button disabled={busy} onClick={download}>Download encrypted passwords</Button>}
      </Space>
      {job && job.state !== 'idle' && <Alert type={job.state === 'failed' || job.state === 'cancelled' ? 'error' : job.state === 'succeeded' ? 'success' : 'info'} showIcon message={`Native password ${job.kind}: ${job.state}`} description={job.error ? job.error.message : job.state === 'waiting_for_windows_dismissal' ? 'Cancellation requested. Dismiss Windows Security on the device desktop. Temporary password data has been removed; only this transfer settings tab will close afterward. Anubis cannot safely identify an OS credential prompt as belonging to this browser.' : job.state === 'waiting_for_windows_approval' ? 'Approve Windows Security on the device desktop. Anubis will not enter or request your Windows password.' : job.imported ? 'The browser confirmed password import.' : undefined} />}
      {error && <Alert type='error' showIcon message={error} />}
      {transportError && <Alert type='error' showIcon message={transportError} />}
    </Space>
  )
}

function DataTab () {
  const { browserId } = useContext(HubCtx)
  const [domains, setDomains] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [nativeActive, setNativeActive] = useState(false)
  const [result, setResult] = useState('')
  const transfer = async kind => {
    setBusy(true)
    setResult('')
    try {
      if (passphrase.length < 12 || passphrase.length > 256) throw new Error('Use a file passphrase of 12 to 256 characters')
      const payload = { browserId, confirmed: true, passphrase }
      if (kind === 'export') payload.domains = domains.split(/[,\s]+/).filter(Boolean)
      else {
        if (!file || file.size > 3 * 1024 * 1024) throw new Error('Select an encrypted cookie file smaller than 3 MiB')
        payload.artifact = JSON.parse(await file.text())
      }
      const data = await hub.ipc(kind === 'export' ? 'cookies.exportFile' : 'cookies.importFile', payload)
      if (kind === 'export') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(data.artifact)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = 'anubis-cookies-encrypted.json'
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      setResult(`${kind === 'export' ? 'Exported' : 'Imported'} ${data.count} cookies`)
    } catch (e) { fail(e) } finally { setPassphrase(''); setBusy(false) }
  }
  const confirm = kind => Modal.confirm({
    title: kind === 'export' ? 'Export browser sessions?' : 'Import browser sessions?',
    content: 'Cookies can grant access to signed-in accounts. Continue only for a browser and accounts you are authorized to manage. The file is encrypted; keep its passphrase separately.',
    okText: kind === 'export' ? 'Export encrypted file' : 'Import encrypted file',
    onOk: () => transfer(kind)
  })
  const nativePasswords = () => Modal.confirm({
    title: 'Open native password manager?',
    content: 'Only you operate the browser password manager. Browser and Windows confirmations still apply. Native file dialogs may require access to this device desktop; they are not captured by the browser stream. Passwords are not sent to AI or read from the credential database.',
    onOk: async () => {
      try { await hub.ipc('passwords.openNative', { browserId, confirmed: true }) } catch (e) { fail(e) }
    }
  })
  return (
    <NeedBrowser>
      <Space direction='vertical' style={{ width: '100%' }}>
        <Alert type='warning' showIcon message='Administrator-only browser data transfer' description='Cookie files are encrypted on the device. Plaintext cookies are not returned to this page or to automation agents. The file passphrase is used only for this operation and is not saved.' />
        <Input aria-label='Cookie domains' placeholder='Domains to export: example.com, example.org' value={domains} onChange={e => setDomains(e.target.value)} />
        <Input.Password aria-label='Cookie file passphrase' autoComplete='new-password' placeholder='File passphrase (at least 12 characters)' value={passphrase} onChange={e => setPassphrase(e.target.value)} />
        <input aria-label='Encrypted cookie file' type='file' accept='.json,application/json' onChange={e => setFile(e.target.files[0] || null)} />
        <Space>
          <Button disabled={busy || !domains.trim() || passphrase.length < 12} onClick={() => confirm('export')}>Export cookies</Button>
          <Button disabled={busy || !file || passphrase.length < 12} onClick={() => confirm('import')}>Import cookies</Button>
        </Space>
        {result && <Alert type='success' message={result} />}
        <PasswordFiles browserId={browserId} onActive={setNativeActive} />
        <Button disabled={nativeActive} onClick={nativePasswords}>Open native password manager</Button>
      </Space>
    </NeedBrowser>
  )
}

function ControlCenterTab () {
  const [data, reload] = useHubData(() => hub.ipc('controlCenter.status'))
  const [settings, setSettings] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data && data.settings && !settings) setSettings(data.settings)
  }, [data, settings])
  useEffect(() => {
    let stopped = false
    let timer
    const poll = async () => {
      await reload()
      if (!stopped) timer = setTimeout(poll, 3000)
    }
    timer = setTimeout(poll, 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [reload])
  const call = async (action, payload) => {
    setBusy(true)
    try {
      const result = await hub.ipc('controlCenter.' + action, payload)
      if (action === 'configure') setSettings(result.settings)
      await reload()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const confirm = (action, title) => Modal.confirm({ title, onOk: () => call(action) })
  const locked = key => busy || !settings || (data && (data.forceDisabled || (data.locked || []).includes(key)))
  if (data && !data.settings) return <Alert type='info' message='Update Anubis on this device to configure the Control Center channel here.' />
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Alert type='info' showIcon message='Remote Control Center' description='Opt-in outbound WSS connection. The center schedules tasks; device policy and browser-secret restrictions still apply. Existing Browser engine views are unchanged.' />
      <Space>
        <Text>Enable channel</Text>
        <Switch checked={!!(settings && settings.enabled)} disabled={locked('enabled')} onChange={enabled => setSettings({ ...settings, enabled })} />
        <Text>Reconnect after app restart</Text>
        <Switch checked={!!(settings && settings.autoConnect)} disabled={locked('autoConnect')} onChange={autoConnect => setSettings({ ...settings, autoConnect })} />
      </Space>
      <Input aria-label='Control Center WSS URL' placeholder='wss://control.example/ws/v1/device' value={(settings && settings.url) || ''} disabled={locked('url') || !!(data && data.enrolled)} onChange={e => setSettings({ ...settings, url: e.target.value })} />
      <Button disabled={busy || !settings} onClick={() => call('configure', settings)}>Save channel settings</Button>
      {data && (
        <Space direction='vertical'>
          <Text>State: {data.state}{data.lastError ? ` (${data.lastError})` : ''}</Text>
          <Text>Device: {data.deviceId || 'not enrolled'}</Text>
          {data.serverKeyFingerprint && <Text copyable>Server key fingerprint: {data.serverKeyFingerprint}</Text>}
          {data.enrolled && !data.keyProtected && <Alert type='warning' message='The device signing key is not protected by the OS credential store. Check device configuration before production use.' />}
          {data.takeover && <Alert type='warning' message='Manual takeover is active; agent commands are blocked.' />}
        </Space>
      )}
      <Input.Password aria-label='Enrollment token' autoComplete='off' placeholder='Single-use enrollment token' value={token} disabled={busy || !(data && data.enabled) || data.enrolled} onChange={e => setToken(e.target.value)} />
      <Space wrap>
        <Button disabled={busy || !token.trim() || !(data && data.enabled) || data.enrolled} onClick={async () => { const value = token.trim(); setToken(''); await call('enroll', { token: value }) }}>Enroll device</Button>
        <Button disabled={busy || !(data && data.enrolled && data.enabled) || data.killed} onClick={() => call('connect')}>Connect</Button>
        <Button disabled={busy || !(data && data.enabled)} onClick={() => call('disconnect')}>Disconnect</Button>
        <Button danger disabled={busy || !(data && data.enabled)} onClick={() => confirm('kill', 'Stop the remote channel and keep it stopped after restart?')}>Emergency stop</Button>
        <Button disabled={busy || !(data && data.enabled && data.killed)} onClick={() => call('resume')}>Clear emergency stop</Button>
        <Button danger disabled={busy || !(data && data.enabled && data.enrolled)} onClick={() => confirm('forget', 'Forget enrollment and the pinned server key? Revoke the old device in the Control Center before enrolling again.')}>Forget enrollment</Button>
      </Space>
    </Space>
  )
}

function ModulesTab () {
  const [status, setStatus] = useState(null)
  const [modules, setModules] = useState([])
  const [jobs, setJobs] = useState([])
  const [moduleId, setModuleId] = useState(null)
  const [input, setInput] = useState('{}')
  const [selectedResult, setSelectedResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [transportError, setTransportError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const state = await hub.ipc('modules.status')
      setStatus(state)
      if (state.configured) {
        const [catalog, history] = await Promise.all([hub.ipc('modules.list'), hub.ipc('modules.jobs')])
        setModules(catalog.modules)
        setJobs(history.jobs)
      }
      setTransportError('')
    } catch (e) { setStatus(null); setTransportError(e.message) }
  }, [])
  useEffect(() => {
    let stopped = false
    let timer
    const poll = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(poll, 3000)
    }
    poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh])
  const act = async (action, payload) => {
    setBusy(true)
    setError('')
    try {
      const result = await hub.ipc('modules.' + action, payload)
      if (action === 'result') setSelectedResult(result.result)
      await refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const create = async () => {
    let parsed
    try { parsed = JSON.parse(input) } catch { setError('Module input must be valid JSON'); return }
    if (moduleId === 'cve-scanner' && parsed.onlineLookup === true) {
      Modal.confirm({
        title: 'Check public vulnerability databases?',
        content: 'If no inventory is supplied, the scanner will collect installed software locally. It sends supported package ecosystem, name, and version values to OSV, exact software and Windows product CPEs to NVD, and downloads the public CISA KEV catalog. It does not upload the full inventory or unmapped program names.',
        okText: 'Check databases',
        cancelText: 'Cancel',
        onOk: () => act('createJob', { moduleId, input: parsed })
      })
      return
    }
    await act('createJob', { moduleId, input: parsed })
  }
  const onlineLookupRequested = moduleId === 'cve-scanner' && (() => {
    try { return JSON.parse(input).onlineLookup === true } catch (e) { return false }
  })()
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Alert type='info' showIcon message='Independent module Broker' description='Modules run through a separate Broker process on this device. The Web client never receives its API token. Install paths and trusted module pins can only be configured locally by an administrator.' />
      {error && <Alert type='error' showIcon message={error} />}
      {transportError && <Alert type='error' showIcon message={transportError} />}
      {onlineLookupRequested && <Alert type='warning' showIcon message='Online lookup is enabled for this scan. The Run module button will ask before querying OSV and NVD and downloading the CISA KEV catalog.' />}
      {status && !status.configured && <Alert type='warning' showIcon message='The independent Broker is not configured on this device.' />}
      {status && status.configured && (
        <>
          <Alert type={status.executionEnabled ? 'warning' : 'info'} showIcon message={status.executionEnabled ? 'Module execution explicitly enabled without enforced OS isolation' : 'Module execution disabled'} description='Network isolation and a restricted process account are not enforced by this build. Only run reviewed modules in a controlled environment.' />
          {(status.rejectedModules || []).map((item, index) => <Alert key={index} type='error' message={item.code + ': ' + item.message} />)}
          <Table
            size='small' rowKey='id' pagination={false} dataSource={modules} columns={[
              { title: 'Module', dataIndex: 'name' },
              { title: 'Version', dataIndex: 'version' },
              { title: 'Trust', render: (_, item) => item.bundlePinned ? <Tag color='green'>Whole-directory pin</Tag> : <Tag color='red'>Not bundle-pinned</Tag> }
            ]}
          />
          <Select aria-label='Module' placeholder='Select an installed module' value={moduleId} onChange={setModuleId} style={{ minWidth: 250 }} options={modules.map(item => ({ value: item.id, label: item.name }))} />
          <Input.TextArea aria-label='Module input JSON' value={input} onChange={e => setInput(e.target.value)} rows={5} maxLength={1024 * 1024} />
          <Button type='primary' disabled={busy || !moduleId || !status.executionEnabled} onClick={create}>Run module</Button>
          <Table
            size='small' rowKey='jobId' pagination={{ pageSize: 10 }} dataSource={jobs} columns={[
              { title: 'Job', dataIndex: 'jobId', ellipsis: true },
              { title: 'Module', dataIndex: 'moduleId' },
              { title: 'State', dataIndex: 'state' },
              { title: 'Progress', render: (_, job) => job.progress ? `${job.progress.percent}% ${job.progress.message || ''}` : '' },
              { title: 'Error', render: (_, job) => job.error ? `${job.error.code}: ${job.error.message}` : '' },
              {
                title: '',
                render: (_, job) => (
                  <Space>
                    <Button size='small' disabled={busy || job.state !== 'done'} onClick={() => act('result', { jobId: job.jobId })}>View result</Button>
                    <Button size='small' danger disabled={busy || !['queued', 'running'].includes(job.state)} onClick={() => act('cancel', { jobId: job.jobId })}>Cancel job</Button>
                  </Space>
                )
              }
            ]}
          />
          {selectedResult && <pre style={{ maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(selectedResult, null, 2)}</pre>}
        </>
      )}
      <Button disabled={busy} onClick={refresh}>Refresh modules</Button>
    </Space>
  )
}

function ApiTab () {
  const [tokens, reloadTokens] = useHubData(() => hub.tokensList())
  const [policyData, reloadPolicy] = useHubData(() => hub.policyGet())
  const [label, setLabel] = useState('')
  const [newToken, setNewToken] = useState('')
  const [policy, setPolicy] = useState(null)
  const [role, setRole] = useState('agent')

  useEffect(() => {
    if (policyData && policyData.policy) setPolicy(policyData.policy)
  }, [policyData])

  const create = async () => {
    try {
      const res = await hub.tokensIssue({ role, ...(label.trim() ? { label: label.trim().slice(0, 60) } : {}) })
      setNewToken(res.token)
      setLabel('')
      reloadTokens()
    } catch (e) { fail(e) }
  }
  const revoke = async (id) => {
    try {
      await hub.tokensRevoke(id)
      reloadTokens()
    } catch (e) { fail(e) }
  }
  const savePolicy = async () => {
    const errors = validatePolicy(policy)
    if (errors.length) {
      handleErr({ message: errors.join('; ') })
      return
    }
    try {
      const res = await hub.policySet(policy)
      setPolicy(res.policy)
      notification.success({ message: 'Policy saved' })
    } catch (e) { fail(e) }
  }
  const resetPolicy = async () => {
    try {
      const res = await hub.policyReset()
      setPolicy(res.policy)
      reloadPolicy()
    } catch (e) { fail(e) }
  }
  const setAllowInstall = (v) => setPolicy(p => ({ ...p, extensions: { ...(p.extensions || {}), allowInstall: v } }))

  const commands = Array.from(new Set(DEFAULT_DENY.concat(
    ((policy && policy.roles && policy.roles[role] && policy.roles[role].rules) || []).map(r => r.command).filter(c => c !== '*')
  )))

  return (
    <Space direction='vertical' size='middle' style={{ width: '100%' }}>
      <Alert type='info' showIcon message='Anything not explicitly allowed is denied. Dangerous commands always need a local human confirmation.' />

      <div>
        <Text strong>Access tokens</Text>
        <Space className='mg1t mg1b' wrap>
          <Input style={{ width: 200 }} value={label} placeholder='Label' maxLength={60} onChange={e => setLabel(e.target.value)} />
          <Select style={{ width: 120 }} value={role} onChange={setRole} options={['agent', 'operator'].map(v => ({ value: v, label: v }))} />
          <Button type='primary' onClick={create}>Create token</Button>
        </Space>
        {newToken && (
          <Alert
            type='success'
            closable
            onClose={() => setNewToken('')}
            message='Copy this token now - it will not be shown again.'
            description={<Paragraph copyable code>{newToken}</Paragraph>}
          />
        )}
        <Table
          size='small'
          rowKey='id'
          pagination={false}
          dataSource={(tokens && tokens.tokens) || []}
          columns={[
            { title: 'Label', dataIndex: 'label' },
            { title: 'Role', dataIndex: 'role' },
            { title: 'Created', dataIndex: 'createdAt' },
            { title: 'Expires', dataIndex: 'expiresAt' },
            { title: '', render: (_, r) => <Button size='small' danger onClick={() => revoke(r.id)}>Revoke</Button> }
          ]}
        />
      </div>

      <div>
        <Text strong>Policy (role: {role})</Text>
        {policyData && policyData.adminLocked && (
          <Alert className='mg1t' type='warning' showIcon message='An administrator overlay applies; it can only restrict your policy.' />
        )}
        <div className='mg1t'>
          <Space>
            <Switch checked={!!(policy && policy.extensions && policy.extensions.allowInstall)} disabled={!policy} onChange={setAllowInstall} />
            <Text>Allow extension install (relaunch browsers after enabling)</Text>
          </Space>
        </div>
        <Table
          className='mg1t'
          size='small'
          rowKey={c => c}
          pagination={false}
          dataSource={commands}
          columns={[
            { title: 'Command', render: c => c },
            {
              title: 'Effect',
              render: c => (
                <Select
                  size='small'
                  style={{ width: 110 }}
                  value={effectFor(policy, role, c)}
                  onChange={v => setPolicy(p => setRule(p, role, c, v))}
                  options={EFFECTS.map(v => ({ value: v, label: v }))}
                />
              )
            }
          ]}
        />
        <Space className='mg1t'>
          <Button type='primary' disabled={!policy} onClick={savePolicy}>Save policy</Button>
          <Button onClick={resetPolicy}>Reset to defaults</Button>
        </Space>
      </div>
    </Space>
  )
}

// Registers as approver while mounted and shows a modal per confirmation.requested event.
function useApprover () {
  useEffect(() => {
    const seen = new Set()
    const ask = (c) => {
      if (!c || !c.confirmationId || seen.has(c.confirmationId)) return
      seen.add(c.confirmationId)
      const decide = (approve) => hub.confirmationsDecide(c.confirmationId, approve).catch(fail)
      Modal.confirm({
        title: `Confirm: ${c.command}`,
        content: c.summary,
        okText: 'Approve',
        cancelText: 'Deny',
        onOk: () => decide(true),
        onCancel: () => decide(false)
      })
    }
    const off = hub.onEvent(ev => {
      if (ev && ev.event === 'confirmation.requested') ask({ ...ev.data })
    }, fail)
    hub.approverRegister()
      .then(() => hub.confirmationsList())
      .then(res => (res.items || []).forEach(ask))
      .catch(fail)
    return () => {
      off()
      hub.approverUnregister().catch(() => {})
    }
  }, [])
}

function BrowserBar ({ status, browserId, setBrowserId, reloadStatus, profileId }) {
  const browsers = (status && status.browsers) || []
  const engines = (status && status.engines) || []
  const [engine, setEngine] = useState(null)
  const launch = async () => {
    try {
      const res = await hub.exec('browser.launch', { engine: engine || (engines[0] && engines[0].engine), ...(profileId ? { profileId } : {}) })
      await reloadStatus()
      setBrowserId(res.browserId)
    } catch (e) { fail(e) }
  }
  const close = async () => {
    try {
      await hub.exec('browser.close', {}, { browserId })
      setBrowserId(null)
      await reloadStatus()
    } catch (e) { fail(e) }
  }
  return (
    <Space className='mg1b' wrap>
      <Select
        style={{ width: 220 }}
        placeholder='No browser running'
        value={browserId}
        onChange={setBrowserId}
        options={browsers.map(b => ({ value: b.browserId, label: `${b.engine} ${b.browserId} (${b.tabCount} tabs)` }))}
      />
      <Select
        style={{ width: 100 }}
        value={engine || (engines[0] && engines[0].engine)}
        onChange={setEngine}
        options={engines.map(e => ({ value: e.engine, label: e.engine }))}
      />
      <Button type='primary' disabled={!engines.length} onClick={launch}>Launch</Button>
      <Button danger disabled={!browserId} onClick={close}>Close</Button>
    </Space>
  )
}

export default function BrowserHubPanel ({ sessionId, engine }) {
  const [status, setStatus] = useState(null)
  const [disabled, setDisabled] = useState(false)
  const [remoteOnly, setRemoteOnly] = useState(false)
  const [browserId, setBrowserId] = useState(null)
  const [profileId, setProfileId] = useState(null)
  const reloadStatus = useCallback(async () => {
    try {
      const s = await hub.status()
      setStatus(s)
      setDisabled(false)
      const linked = s.browsers.find(b => b.engine === engine && (b.sessionIds || []).includes(sessionId))
      setBrowserId(cur => linked ? linked.browserId : (s.browsers.some(b => b.browserId === cur) ? cur : (s.browsers[0] && s.browsers[0].browserId) || null))
    } catch (e) {
      if (e.code === 'DISABLED') setDisabled(true)
      else if (e.code === 'REMOTE_UNSUPPORTED') setRemoteOnly(true)
      else fail(e)
    }
  }, [sessionId, engine])
  useEffect(() => { reloadStatus() }, [reloadStatus])
  useEffect(() => hub.onEvent(ev => {
    if (ev.event.startsWith('browser.') || ev.event === 'events.dropped') reloadStatus()
  }, fail), [reloadStatus])
  useApprover()

  if (remoteOnly) {
    return (
      <div className='browser-hub-panel'>
        <Alert type='info' showIcon message='This device runs a version without Browser Hub support. Update Anubis on the device.' />
      </div>
    )
  }
  if (disabled) {
    return (
      <div className='browser-hub-panel'>
        <Alert type='warning' showIcon message='Browser Hub is disabled. Enable browserApiEnabled in settings (or set ANUBIS_BROWSER_API=1) and restart.' />
      </div>
    )
  }
  return (
    <div className='browser-hub-panel'>
      {hub.isMock() && <Alert type='warning' showIcon message='Browser Hub backend not connected - showing mock data.' />}
      <HubCtx.Provider value={{ browserId, engine, profileId, setProfileId, reloadStatus }}>
        <BrowserBar status={status} browserId={browserId} setBrowserId={setBrowserId} reloadStatus={reloadStatus} profileId={profileId} />
        <Tabs
          size='small'
          items={[
            { key: 'profiles', label: 'Profiles', children: <ProfilesTab /> },
            { key: 'tabs', label: 'Tabs', children: <TabsTab /> },
            { key: 'ext', label: 'Extensions', children: <ExtensionsTab /> },
            { key: 'history', label: 'History', children: <HistoryTab /> },
            { key: 'data', label: 'Cookies & passwords', children: <DataTab /> },
            { key: 'control', label: 'Control Center', children: <ControlCenterTab /> },
            { key: 'modules', label: 'Modules', children: <ModulesTab /> },
            { key: 'api', label: 'API / AI access', children: <ApiTab /> }
          ]}
        />
      </HubCtx.Provider>
    </div>
  )
}
