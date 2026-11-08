export function inventoryBytes (value) {
  return Number.isSafeInteger(value) && value >= 0
    ? `${(value / (1024 ** 3)).toFixed(1)} GiB (${value} bytes)`
    : 'Unknown'
}

export function hardwareDetails (inventory) {
  if (!inventory) return { status: 'Not reported by this agent' }
  const { memory, gpu, domain } = inventory
  const collected = inventory.collectedAt === null || inventory.collectedAt === undefined
    ? null
    : new Date(inventory.collectedAt)
  return {
    status: inventory.status,
    source: inventory.source || 'Unknown',
    collectedAt: collected && Number.isFinite(collected.getTime()) ? collected.toISOString() : 'Not collected yet',
    ...(inventory.error ? { error: inventory.error } : {}),
    memory: {
      totalPhysical: inventoryBytes(memory?.totalPhysicalBytes),
      installedPhysical: inventoryBytes(memory?.installedPhysicalBytes),
      source: memory?.source || 'Unknown'
    },
    graphics: {
      status: gpu?.status || 'Unknown',
      source: gpu?.source || 'Unknown',
      truncated: gpu?.truncated === true,
      adapters: (gpu?.adapters || []).map(adapter => ({
        model: adapter.name || 'Unknown',
        type: adapter.kind || 'unknown',
        typeSource: adapter.kindSource || 'Unknown',
        dedicatedVideoMemory: inventoryBytes(adapter.dedicatedVideoMemoryBytes),
        dedicatedSystemMemory: inventoryBytes(adapter.dedicatedSystemMemoryBytes),
        sharedSystemMemoryBudget: inventoryBytes(adapter.sharedSystemMemoryBytes),
        memorySource: adapter.memorySource || 'Unknown'
      }))
    },
    ...(inventory.client
      ? {
          client: {
            status: inventory.client.status,
            collectedAt: inventory.client.collectedAt ? new Date(inventory.client.collectedAt).toISOString() : 'Not collected',
            runtimeRole: inventory.client.role || 'Unknown',
            securityStatus: inventory.client.security.status,
            antivirus: inventory.client.security.products,
            softwareStatus: inventory.client.software.status,
            softwareScope: inventory.client.software.scope,
            softwareTruncated: inventory.client.software.truncated,
            installedSoftware: inventory.client.software.items.map(item => [item.name, item.version].filter(Boolean).join(' '))
          }
        }
      : {}),
    membership: {
      status: domain?.status || 'Unknown',
      source: domain?.source || 'Unknown',
      domainJoined: domain?.partOfDomain === true ? 'Yes' : domain?.partOfDomain === false ? 'No' : 'Unknown',
      domain: domain?.partOfDomain === true ? domain.domain || 'Unknown' : domain?.partOfDomain === false ? 'Not applicable' : 'Unknown',
      workgroup: domain?.partOfDomain === false ? domain.workgroup || 'Unknown' : domain?.partOfDomain === true ? 'Not applicable' : 'Unknown'
    }
  }
}
