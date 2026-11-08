import { useState } from 'react'
import { Alert, Button, Form, Input, Tooltip } from 'antd'

export default function ModulePathField ({ id, label, value, onChange, disabled = false, help }) {
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const canBrowse = !window.et?.isWebApp && typeof window.api?.openDialog === 'function'

  const browse = async () => {
    setPicking(true)
    setError('')
    try {
      const paths = await window.api.openDialog({
        title: label,
        defaultPath: value || undefined,
        properties: ['openDirectory', 'dontAddToRecent']
      })
      if (paths?.[0]) onChange(paths[0])
    } catch (error) {
      setError(`Could not choose a folder: ${error.message}`)
    } finally {
      setPicking(false)
    }
  }

  return (
    <Form.Item label={label} htmlFor={id} extra={help}>
      <div className='module-path-input'>
        <Input id={id} value={value} onChange={event => onChange(event.target.value)} disabled={disabled || picking} />
        <Tooltip title={canBrowse ? 'Choose a local folder' : 'Enter the path on the target PC. Remote folder browsing requires Broker support.'}>
          <span>
            <Button onClick={browse} disabled={disabled || !canBrowse} loading={picking} aria-label={`Browse ${label}`}>Browse...</Button>
          </span>
        </Tooltip>
      </div>
      {error && <Alert type='error' title={error} showIcon />}
    </Form.Item>
  )
}
