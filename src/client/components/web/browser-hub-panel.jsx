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
const HubCtx = createContext({ browserId: null, profileId: null, setProfileId: () => {}, reloadStatus: () => {} })

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
  if (!browserId) return <Alert type='info' showIcon message='Launch a browser (button above) to use this tab.' />
  return children
}

function ProfilesTab () {
  const { profileId, setProfileId } = useContext(HubCtx)
  const [data] = useHubData(() => hub.exec('profile.list', {}))
  const select = async (id) => {
    try {
      await hub.exec('profile.select', { profileId: id })
      setProfileId(id)
    } catch (e) { fail(e) }
  }
  return (
    <Table
      size='small'
      rowKey='profileId'
      pagination={false}
      dataSource={(data && data.profiles) || []}
      columns={[
        { title: 'Profile', dataIndex: 'displayName' },
        { title: 'Engine', dataIndex: 'engine' },
        { title: 'Account', dataIndex: 'accountHint' },
        { title: 'Source', dataIndex: 'source' },
        { title: 'State', render: (_, r) => r.inUse ? <Tag color='orange'>in use</Tag> : (profileId === r.profileId ? <Tag color='green'>selected</Tag> : null) },
        { title: '', render: (_, r) => <Button size='small' disabled={profileId === r.profileId} onClick={() => select(r.profileId)}>Select</Button> }
      ]}
    />
  )
}

function TabsTab () {
  const exec = useExec()
  const { browserId } = useContext(HubCtx)
  const [data, reload] = useHubData(() => browserId ? exec('tab.list', {}) : Promise.resolve(null), [browserId])
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
            {
              title: 'Enabled',
              render: (_, r) => <Switch checked={!!r.enabled} onChange={v => act(v ? 'extension.enable' : 'extension.disable', { extensionId: r.extensionId })} />
            },
            { title: '', render: (_, r) => <Button size='small' danger onClick={() => act('extension.remove', { extensionId: r.extensionId }, r.name)}>Remove</Button> }
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
      setItems(res.items || [])
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

function DataTab () {
  return (
    <Alert
      type='info'
      showIcon
      message='Cookie and password import/export are not available from the UI'
      description='The backend blocks cookies.export/import and passwords.export/import for the UI actor, and password transfer is not supported by this build. Secrets are never returned over IPC.'
    />
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
    })
    hub.approverRegister()
      .then(() => hub.confirmationsList())
      .then(res => (res.items || []).forEach(ask))
      .catch(() => {})
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

export default function BrowserHubPanel () {
  const [status, setStatus] = useState(null)
  const [disabled, setDisabled] = useState(false)
  const [browserId, setBrowserId] = useState(null)
  const [profileId, setProfileId] = useState(null)
  const reloadStatus = useCallback(async () => {
    try {
      const s = await hub.status()
      setStatus(s)
      setDisabled(false)
      setBrowserId(cur => (s.browsers.some(b => b.browserId === cur) ? cur : (s.browsers[0] && s.browsers[0].browserId) || null))
    } catch (e) {
      if (e.code === 'DISABLED') setDisabled(true)
      else fail(e)
    }
  }, [])
  useEffect(() => { reloadStatus() }, [reloadStatus])
  useApprover()

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
      <HubCtx.Provider value={{ browserId, profileId, setProfileId, reloadStatus }}>
        <BrowserBar status={status} browserId={browserId} setBrowserId={setBrowserId} reloadStatus={reloadStatus} profileId={profileId} />
        <Tabs
          size='small'
          items={[
            { key: 'profiles', label: 'Profiles', children: <ProfilesTab /> },
            { key: 'tabs', label: 'Tabs', children: <TabsTab /> },
            { key: 'ext', label: 'Extensions', children: <ExtensionsTab /> },
            { key: 'history', label: 'History', children: <HistoryTab /> },
            { key: 'data', label: 'Cookies & passwords', children: <DataTab /> },
            { key: 'api', label: 'API / AI access', children: <ApiTab /> }
          ]}
        />
      </HubCtx.Provider>
    </div>
  )
}
