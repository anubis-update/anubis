const { test } = require('node:test')
const assert = require('node:assert/strict')

test('hardware details distinguish zero, unknown, dedicated and shared bytes without summing adapters', async () => {
  const { hardwareDetails, inventoryBytes } = await import('../../client/common/hardware-inventory-view.mjs')
  assert.equal(inventoryBytes(null), 'Unknown')
  assert.equal(inventoryBytes(-1), 'Unknown')
  assert.equal(inventoryBytes(0), '0.0 GiB (0 bytes)')
  assert.equal(inventoryBytes(12 * 1024 ** 3), '12.0 GiB (12884901888 bytes)')
  const info = hardwareDetails({
    status: 'ok',
    collectedAt: 1793620800000,
    memory: { totalPhysicalBytes: 24 * 1024 ** 3, installedPhysicalBytes: null },
    gpu: {
      adapters: [
        { name: 'Dedicated adapter', dedicatedVideoMemoryBytes: 12 * 1024 ** 3, sharedSystemMemoryBytes: 8 * 1024 ** 3 },
        { name: 'Integrated adapter', dedicatedVideoMemoryBytes: 0, sharedSystemMemoryBytes: 8 * 1024 ** 3 }
      ]
    },
    domain: { partOfDomain: false, workgroup: 'WORKGROUP' }
  })
  assert.equal(info.graphics.adapters.length, 2)
  assert.equal(info.graphics.adapters[0].dedicatedVideoMemory, '12.0 GiB (12884901888 bytes)')
  assert.equal(info.graphics.adapters[1].dedicatedVideoMemory, '0.0 GiB (0 bytes)')
  assert.equal(info.membership.domainJoined, 'No')
  assert.equal(info.membership.workgroup, 'WORKGROUP')
  assert.equal(info.membership.domain, 'Not applicable')
  assert.equal(info.memory.installedPhysical, 'Unknown')
})

test('unknown membership does not invent a home network or workgroup', async () => {
  const { hardwareDetails } = await import('../../client/common/hardware-inventory-view.mjs')
  assert.equal(hardwareDetails(null).status, 'Not reported by this agent')
  const unknown = hardwareDetails({ status: 'collecting', collectedAt: null, domain: { partOfDomain: null } })
  assert.equal(unknown.membership.domainJoined, 'Unknown')
  assert.equal(unknown.collectedAt, 'Not collected yet')
  const joined = hardwareDetails({ domain: { partOfDomain: true, domain: 'example.test' } })
  assert.equal(joined.membership.domain, 'example.test')
  assert.equal(joined.membership.workgroup, 'Not applicable')
})
