import React, { useState, useEffect, useCallback } from 'react'
import { Tabs, Button, Space, Table, Input, Switch, Typography, Alert, Select, Tag } from 'antd'
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

function downloadJson (obj, fileName) {
  const blob = new window.Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const href = window.URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = href
  a.download = fileName
  window.document.body.appendChild(a)
  a.click()
  window.document.body.removeChild(a)
  window.URL.revokeObjectURL(href)
}

function readJsonFile (event, cb) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return
  const reader = new window.FileReader()
  reader.onload = () => {
    try {
      cb(JSON.parse(reader.result))
    } catch (e) {
      handleErr({ message: 'Import failed: ' + e.message })
    }
  }
  reader.readAsText(file)
}

// Loads data through the hub adapter; errors surface via handleErr.
function useHubData (command, params) {
  const [data, setData] = useState(null)
  const reload = useCallback(async () => {
    try {
      setData(await hub.call(command, params))
    } catch (e) {
      handleErr({ message: e.message })
    }
  }, [command, JSON.stringify(params)])
  useEffect(() => { reload() }, [reload])
  return [data, reload]
}

function ProfilesTab () {
  const [data, reload] = useHubData('profile.list', {})
  const select = async (profileId) => {
    try {
      await hub.call('profile.select', { profileId })
      reload()
    } catch (e) { handleErr({ message: e.message }) }
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
        { title: 'State', render: (_, r) => r.inUse ? <Tag color='orange'>in use</Tag> : (data && data.selected === r.profileId ? <Tag color='green'>selected</Tag> : null) },
        { title: '', render: (_, r) => <Button size='small' disabled={data && data.selected === r.profileId} onClick={() => select(r.profileId)}>Select</Button> }
      ]}
    />
  )
}

function TabsTab () {
  const [data, reload] = useHubData('tab.list', {})
  const [url, setUrl] = useState('')
  const act = async (command, params) => {
    try {
      await hub.call(command, params)
      reload()
    } catch (e) { handleErr({ message: e.message }) }
  }
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input value={url} placeholder='https://' onChange={e => setUrl(e.target.value)} onPressEnter={() => { act('tab.new', { url: url || 'about:blank' }); setUrl('') }} />
        <Button type='primary' onClick={() => { act('tab.new', { url: url || 'about:blank' }); setUrl('') }}>Open tab</Button>
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
                <Button size='small' disabled={r.active} onClick={() => act('tab.activate', { tabId: r.tabId })}>Switch</Button>
                <Button size='small' danger onClick={() => act('tab.close', { tabId: r.tabId })}>Close</Button>
              </Space>
            )
          }
        ]}
      />
    </Space>
  )
}

function ExtensionsTab () {
  const [data, reload] = useHubData('extension.list', {})
  const [path, setPath] = useState('')
  const [run] = useGuardedCall(hub.call)
  const act = async (command, params, detail) => {
    try {
      await run(command, params, detail)
      reload()
    } catch (e) { handleErr({ message: e.message }) }
  }
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Space>
        <Text>Developer mode</Text>
        <Switch checked={!!(data && data.devMode)} onChange={v => act('devMode.set', { enabled: v })} />
      </Space>
      <Space.Compact style={{ width: '100%' }}>
        <Input value={path} placeholder='Path to unpacked extension folder' onChange={e => setPath(e.target.value)} />
        <Button
          type='primary'
          disabled={!path.trim()}
          onClick={() => { act('extension.install', { source: 'unpacked', path: path.trim() }, path.trim()); setPath('') }}
        >Install unpacked
        </Button>
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
  )
}

function HistoryTab () {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [run] = useGuardedCall(hub.call)
  const search = useCallback(async () => {
    try {
      const res = query.trim()
        ? await hub.call('history.search', { query: query.trim() })
        : await hub.call('history.list', {})
      setItems(res.items || [])
    } catch (e) { handleErr({ message: e.message }) }
  }, [query])
  useEffect(() => { search() }, [])
  const clear = async () => {
    try {
      if (await run('history.clear', {})) setItems([])
    } catch (e) { handleErr({ message: e.message }) }
  }
  return (
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
  )
}

function DataTab () {
  const [run] = useGuardedCall(hub.call)
  const exportCookies = async () => {
    try {
      const res = await hub.call('cookies.export', {})
      downloadJson(res.cookies, 'anubis-cookies.json')
      notification.success({ message: `Exported ${res.cookies.length} cookies` })
    } catch (e) { handleErr({ message: e.message }) }
  }
  const importCookies = (event) => readJsonFile(event, async data => {
    const cookies = Array.isArray(data) ? data : data.cookies
    if (!Array.isArray(cookies)) throw new Error('Expected a cookie array')
    const res = await hub.call('cookies.import', { cookies })
    notification.success({ message: `Imported ${res.imported} cookies` })
  })
  const exportPasswords = async () => {
    try {
      const res = await run('passwords.export', {})
      if (!res) return
      downloadJson(res.passwords, 'anubis-passwords.json')
      notification.success({ message: `Exported ${res.passwords.length} passwords` })
    } catch (e) { handleErr({ message: e.message }) }
  }
  const importPasswords = (event) => readJsonFile(event, async data => {
    const passwords = Array.isArray(data) ? data : data.passwords
    if (!Array.isArray(passwords)) throw new Error('Expected a password array')
    const res = await run('passwords.import', { passwords }, `${passwords.length} entries`)
    if (res) notification.success({ message: `Imported ${res.imported} passwords` })
  })
  return (
    <Space direction='vertical' size='middle' style={{ width: '100%' }}>
      <div>
        <Text strong>Cookies</Text>
        <div>
          <Space className='mg1t'>
            <Button onClick={exportCookies}>Export cookies</Button>
            <label className='ant-btn ant-btn-default'>Import cookies<input type='file' accept='.json,application/json' style={{ display: 'none' }} onChange={importCookies} /></label>
          </Space>
        </div>
      </div>
      <div>
        <Text strong>Passwords</Text>
        <Alert
          className='mg1t mg1b'
          type='warning'
          showIcon
          message='Password files are PLAIN TEXT. Anyone who obtains the file can read every password. Keep it offline, and delete it after use.'
        />
        <Space>
          <Button danger onClick={exportPasswords}>Export passwords</Button>
          <label className='ant-btn ant-btn-default'>Import passwords<input type='file' accept='.json,application/json' style={{ display: 'none' }} onChange={importPasswords} /></label>
        </Space>
      </div>
    </Space>
  )
}

function ApiTab () {
  const [settings, reloadSettings] = useHubData('api.settings.get', {})
  const [tokens, reloadTokens] = useHubData('api.token.list', {})
  const [auditData, reloadAudit] = useHubData('api.audit.list', { limit: 200 })
  const [label, setLabel] = useState('')
  const [newToken, setNewToken] = useState('')
  const [policy, setPolicy] = useState(null)
  const [role, setRole] = useState('agent')

  useEffect(() => {
    if (settings && settings.policy) setPolicy(settings.policy)
  }, [settings])

  const toggle = async (enabled) => {
    try {
      await hub.call('api.settings.set', { enabled })
      reloadSettings()
    } catch (e) { handleErr({ message: e.message }) }
  }
  const create = async () => {
    try {
      const res = await hub.call('api.token.create', { label: label.trim() || 'token', role })
      setNewToken(res.token)
      setLabel('')
      reloadTokens()
    } catch (e) { handleErr({ message: e.message }) }
  }
  const revoke = async (tokenId) => {
    try {
      await hub.call('api.token.revoke', { tokenId })
      reloadTokens()
    } catch (e) { handleErr({ message: e.message }) }
  }
  const savePolicy = async () => {
    const errors = validatePolicy(policy)
    if (errors.length) {
      handleErr({ message: errors.join('; ') })
      return
    }
    try {
      await hub.call('api.policy.set', { policy })
      notification.success({ message: 'Policy saved' })
    } catch (e) { handleErr({ message: e.message }) }
  }

  const commands = Array.from(new Set(DEFAULT_DENY.concat(
    ((policy && policy.roles && policy.roles[role] && policy.roles[role].rules) || []).map(r => r.command)
  )))

  return (
    <Space direction='vertical' size='middle' style={{ width: '100%' }}>
      <Space>
        <Switch checked={!!(settings && settings.enabled)} onChange={toggle} />
        <Text>Enable local /v1 API (REST / MCP)</Text>
      </Space>
      <Alert type='info' showIcon message='Anything not explicitly allowed is denied. Dangerous commands always need a local human confirmation.' />

      <div>
        <Text strong>Access tokens</Text>
        <Space className='mg1t mg1b' wrap>
          <Input style={{ width: 200 }} value={label} placeholder='Label' onChange={e => setLabel(e.target.value)} />
          <Select style={{ width: 120 }} value={role} onChange={setRole} options={['agent', 'operator', 'admin'].map(v => ({ value: v, label: v }))} />
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
          rowKey='tokenId'
          pagination={false}
          dataSource={(tokens && tokens.tokens) || []}
          columns={[
            { title: 'Label', dataIndex: 'label' },
            { title: 'Role', dataIndex: 'role' },
            { title: 'Created', dataIndex: 'createdAt' },
            { title: '', render: (_, r) => <Button size='small' danger onClick={() => revoke(r.tokenId)}>Revoke</Button> }
          ]}
        />
      </div>

      <div>
        <Text strong>Policy (role: {role})</Text>
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
        <Button className='mg1t' type='primary' disabled={!policy} onClick={savePolicy}>Save policy</Button>
      </div>

      <div>
        <Space>
          <Text strong>Audit log</Text>
          <Button size='small' onClick={reloadAudit}>Refresh</Button>
        </Space>
        <Table
          className='mg1t'
          size='small'
          rowKey='id'
          pagination={{ pageSize: 10 }}
          dataSource={(auditData && auditData.entries) || []}
          columns={[
            { title: 'Time', dataIndex: 'ts', width: 200 },
            { title: 'Actor', render: (_, r) => r.actor && r.actor.kind },
            { title: 'Command', dataIndex: 'command' },
            { title: 'Decision', render: (_, r) => r.decision && r.decision.effect },
            { title: 'OK', render: (_, r) => r.outcome && (r.outcome.ok ? 'yes' : r.outcome.errorCode || 'no') }
          ]}
        />
      </div>
    </Space>
  )
}

export default function BrowserHubPanel () {
  return (
    <div className='browser-hub-panel'>
      {hub.isMock() && <Alert type='warning' showIcon message='Browser Hub backend not connected - showing mock data.' />}
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
    </div>
  )
}
