/**
 * Download tracking from browser-level CDP events (downloads.list). The
 * browser keeps its own download behaviour (`default`); only events are enabled.
 * Items expose the file NAME only (never a local path) and a query-stripped URL.
 */

const path = require('node:path')

function stripUrl (url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'data:' || u.protocol === 'blob:' ? u.protocol : u.origin + u.pathname
  } catch { return '' }
}

function createDownloadTracker ({ client, max = 200, enable = true } = {}) {
  const items = new Map() // guid -> item

  function put (guid, patch) {
    const cur = items.get(guid) || { downloadId: guid, fileName: '', url: '', state: 'in_progress', bytes: 0 }
    items.set(guid, { ...cur, ...patch })
    while (items.size > max) items.delete(items.keys().next().value)
  }

  client.on('Browser.downloadWillBegin', (p) => {
    if (!p || !p.guid) return
    put(String(p.guid), {
      fileName: path.basename(String(p.suggestedFilename || '')).slice(0, 255),
      url: stripUrl(p.url),
      state: 'in_progress'
    })
  })
  client.on('Browser.downloadProgress', (p) => {
    if (!p || !p.guid) return
    const state = p.state === 'completed' ? 'completed' : p.state === 'canceled' ? 'interrupted' : 'in_progress'
    put(String(p.guid), { state, bytes: Math.max(0, Math.floor(Number(p.receivedBytes) || 0)) })
  })

  return {
    async start () {
      if (!enable) return
      try { await client.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }) } catch {}
    },
    list: ({ limit = 50 } = {}) => ({ items: [...items.values()].slice(-Math.min(limit, max)).reverse() })
  }
}

module.exports = { createDownloadTracker, stripUrl }
