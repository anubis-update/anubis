import React, { useState, useEffect, useCallback } from 'react'
import { Button, Space, Typography } from 'antd'
import BrowserPanel from './browser-panel'
import ActivationModal from '../sidebar/activation-modal'
import {
  ENTITLEMENT_ROUTE,
  ACTIVATE_ROUTE,
  parseEntitlement,
  parseActivation
} from './web-entitlement'

const { Text, Paragraph } = Typography

// Browser PRO entitlement gate for the web surface. Unlike the desktop build --
// where the sidebar gate (menu-preview.jsx) is authoritative -- the web client
// now reads entitlement directly from the pinned gateway each time the Browser
// panel opens, and is fail-closed: it only renders BrowserPanel once the gateway
// confirms `entitled: true`. Otherwise it shows the activation flow, reusing the
// sidebar ActivationModal with a web activate() that POSTs to the gateway.
export default function WebBrowserGate (props) {
  // null = loading, true/false = resolved entitlement for this panel open.
  const [entitled, setEntitled] = useState(null)
  const [activateOpen, setActivateOpen] = useState(false)

  const check = useCallback(async () => {
    setEntitled(null)
    try {
      const res = await window.fetch(ENTITLEMENT_ROUTE, {
        credentials: 'same-origin',
        cache: 'no-store'
      })
      const parsed = parseEntitlement(res.ok ? await res.json() : null)
      setEntitled(parsed.entitled)
    } catch (e) {
      setEntitled(false)
    }
  }, [])

  // Re-check on every mount, i.e. every time the Browser panel is opened.
  useEffect(() => { check() }, [check])

  // Web activation: POST the key to the gateway and normalise the result so the
  // shared ActivationModal can report success/failure identically to desktop.
  const activate = useCallback(async (key) => {
    try {
      const res = await window.fetch(ACTIVATE_ROUTE, {
        method: 'post',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key })
      })
      let payload = null
      try { payload = await res.json() } catch (e) {}
      return parseActivation(res.status, payload)
    } catch (e) {
      return { ok: false, entitled: false, proExpiresAt: null, error: 'offline' }
    }
  }, [])

  if (entitled === true) {
    return <BrowserPanel {...props} entitled />
  }

  if (entitled === null) {
    return <div className='pd1'><Text type='secondary'>Checking Browser entitlement...</Text></div>
  }

  return (
    <div className='browser-tools-panel pd1'>
      <Space direction='vertical' size='middle' style={{ width: '100%' }}>
        <Paragraph type='secondary' style={{ marginBottom: 0 }}>
          Browser is a PRO feature. Enter an activation key to unlock it on this
          device.
        </Paragraph>
        <Button type='primary' onClick={() => setActivateOpen(true)}>
          Activate Browser PRO
        </Button>
      </Space>
      <ActivationModal
        open={activateOpen}
        activate={activate}
        onClose={() => setActivateOpen(false)}
        onActivated={() => setEntitled(true)}
      />
    </div>
  )
}
