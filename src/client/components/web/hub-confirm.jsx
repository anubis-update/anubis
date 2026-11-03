import React, { useState, useCallback } from 'react'
import { Modal, Typography } from 'antd'
import { isDangerous, dangerText } from './hub-policy'

const { Paragraph } = Typography

// Resolves true only after an explicit human click. Non-dangerous commands
// skip the modal and run directly.
export function confirmDangerous (command, detail = '') {
  return new Promise(resolve => {
    Modal.confirm({
      title: `Confirm dangerous action: ${command}`,
      okText: 'I understand, proceed',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      content: (
        <div>
          <Paragraph type='danger'>{dangerText(command)}</Paragraph>
          {detail && <Paragraph>{detail}</Paragraph>}
        </div>
      ),
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
}

export function useGuardedCall (call) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (command, params, detail) => {
    if (isDangerous(command) && !(await confirmDangerous(command, detail))) {
      return undefined
    }
    setBusy(true)
    try {
      return await call(command, params)
    } finally {
      setBusy(false)
    }
  }, [call])
  return [run, busy]
}
