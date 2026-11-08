import { useEffect, useState } from 'react'
import { Alert, Button, Col, Divider, Form, InputNumber, Radio, Row, Space, Table, Tooltip, Typography } from 'antd'
import Modal from '../common/modal'
import ModulePage from './module-page'
import ModulePathField from './module-path-field'
import { SCARAB_SETTINGS_KEY, readScarabSettings } from '../../common/scanner-settings.mjs'

const { Text } = Typography
const filters = [
  { key: 'imageType', label: 'Image Type', options: [['any', 'Any'], ['x86', 'x86 images only'], ['x64', 'x64 images only']] },
  { key: 'signState', label: 'Sign State', options: [['any', 'Any'], ['signed', 'Signed']] },
  { key: 'abuseCandidate', label: 'Abuse Candidate', options: [['all', 'All'], ['best', 'Best'], ['good', 'Good'], ['bad', 'Bad']] },
  { key: 'directoryPermission', label: 'Directory Write Permission', options: [['any', 'Any'], ['weak', 'Weak']] }
]
const columns = [
  { title: 'Image / EXE', dataIndex: 'image' },
  { title: 'Architecture', dataIndex: 'architecture', width: 130 },
  { title: 'Signature', dataIndex: 'signature', width: 120 },
  { title: 'Candidate', dataIndex: 'candidate', width: 120 },
  { title: 'Directory permission', dataIndex: 'permission', width: 170 },
  { title: 'DLL count', dataIndex: 'dllCount', width: 100 },
  { title: 'EXE size (KB)', dataIndex: 'exeSize', width: 130 }
]

export default function DllScannerPage ({ onClose }) {
  const [initial] = useState(() => readScarabSettings(window.localStorage))
  const [settings, setSettings] = useState(initial.settings)
  const [storageError, setStorageError] = useState(initial.error)
  const [aboutOpen, setAboutOpen] = useState(false)
  const update = (key, value) => setSettings(current => ({ ...current, [key]: value }))

  useEffect(() => {
    try {
      window.localStorage.setItem(SCARAB_SETTINGS_KEY, JSON.stringify(settings))
    } catch (error) {
      setStorageError(`Could not save Scarab settings: ${error.message}`)
    }
  }, [settings])

  const colorError = settings.greenDllCount > settings.yellowDllCount || settings.greenExeSize > settings.yellowExeSize
  const colorNumber = (key, label) => (
    <InputNumber
      aria-label={label}
      min={0}
      max={Number.MAX_SAFE_INTEGER}
      precision={0}
      value={settings[key]}
      onChange={value => { if (Number.isSafeInteger(value)) update(key, value) }}
      status={colorError ? 'error' : undefined}
    />
  )

  return (
    <ModulePage title='Anubis Scarab — DLL Scanner' name='DLL Scanner' onClose={onClose}>
      <section aria-labelledby='scarab-module-title'>
        <h3 id='scarab-module-title'>Module location</h3>
        <Form layout='vertical'>
          <ModulePathField
            id='scarab-module-path'
            label='Scarab module folder'
            value={settings.modulePath}
            onChange={value => update('modulePath', value)}
            help='Default location for a Broker-managed module. This draft is saved in this browser, not in the installation registry.'
          />
        </Form>
        {storageError && <Alert type='error' title={storageError} showIcon className='mg2b' />}
      </section>

      <Divider />
      <section aria-labelledby='scarab-settings-title'>
        <h3 id='scarab-settings-title'>Scan settings</h3>
        <Form layout='vertical'>
          <ModulePathField
            id='scarab-scan-path'
            label='Folder to scan'
            value={settings.scanPath}
            onChange={value => update('scanPath', value)}
            help='An absolute folder path on the PC where the module will run.'
          />
          <Row gutter={[16, 16]} className='mg2b'>
            {filters.map(({ key, label, options }) => (
              <Col xs={24} sm={12} lg={6} key={key}>
                <Form.Item label={label}>
                  <Radio.Group
                    aria-label={label}
                    value={settings[key]}
                    onChange={event => update(key, event.target.value)}
                  >
                    <Space direction='vertical'>
                      {options.map(([value, name]) => <Radio key={value} value={value}>{name}</Radio>)}
                    </Space>
                  </Radio.Group>
                </Form.Item>
              </Col>
            ))}
          </Row>
          <h3>Color Config</h3>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12}>
              <Form.Item label={<Text type='success'>Green — DLL Count &lt;=</Text>}>
                {colorNumber('greenDllCount', 'Green maximum DLL count')}
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label='Green — EXE Size <= (KB)'>
                {colorNumber('greenExeSize', 'Green maximum EXE size in KB')}
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={<Text type='warning'>Yellow — DLL Count &lt;=</Text>}>
                {colorNumber('yellowDllCount', 'Yellow maximum DLL count')}
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label='Yellow — EXE Size <= (KB)'>
                {colorNumber('yellowExeSize', 'Yellow maximum EXE size in KB')}
              </Form.Item>
            </Col>
          </Row>
          <div className='mg2b'>
            <Text type='danger'>Red — DLL Count &gt; {settings.yellowDllCount}, EXE Size &gt; {settings.yellowExeSize} KB</Text>
          </div>
          {colorError && <Alert className='mg2b' type='warning' title='Green thresholds must not exceed yellow thresholds.' showIcon />}
        </Form>
        <div className='mg2y'>
          <Space wrap>
            <Tooltip title='Scarab execution will be connected through Broker in the next integration stage.'>
              <span><Button type='primary' disabled>Start scan</Button></span>
            </Tooltip>
            <Button disabled>Cancel</Button>
            <Button onClick={() => setAboutOpen(true)}>About</Button>
            <Tooltip title='Export will be available when a Broker scan has produced results.'>
              <span><Button disabled>Export...</Button></span>
            </Tooltip>
          </Space>
        </div>
        <Alert
          type='info'
          showIcon
          title='Interface only: no scan is running'
          description='Module registration, execution, cancellation and result storage will use Broker. Editing these settings does not start a process.'
        />
      </section>

      <Divider />
      <section aria-labelledby='scarab-results-title'>
        <h3 id='scarab-results-title'>Scan results</h3>
        <Table
          size='small'
          rowKey='id'
          columns={columns}
          dataSource={[]}
          pagination={false}
          scroll={{ x: 1000 }}
          locale={{ emptyText: 'No scan results yet. Broker integration is required to run Scarab and store its results.' }}
        />
      </section>
      {aboutOpen && (
        <Modal title='About Anubis Scarab' open onCancel={() => setAboutOpen(false)} footer={<Button onClick={() => setAboutOpen(false)}>Close</Button>}>
          <p>A standalone DLL scanner managed through Anubis Broker.</p>
          <p>Settings follow the supplied Robber reference: image architecture, signatures, abuse candidates, directory write permissions and color thresholds. They do not confirm a vulnerability or run a scan.</p>
        </Modal>
      )}
    </ModulePage>
  )
}
