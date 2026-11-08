const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { apiError } = require('./errors')
const { MAX_BYTES } = require('./password-file')

const execute = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const aborted = () => apiError('CANCELLED', 'Native password transfer was cancelled')

async function nativeDialog (request, signal) {
  const script = path.join(__dirname, '..', 'native-browser-file-dialog.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 16384, signal }, (error, stdout) => {
        if (error) return reject(apiError(signal && signal.aborted ? 'CANCELLED' : 'NATIVE_DIALOG_FAILED', 'Native file dialog operation did not complete'))
        try { resolve(JSON.parse(stdout)) } catch { reject(apiError('NATIVE_DIALOG_FAILED', 'Invalid native file dialog response')) }
      })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

async function privateDirectory (root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(root, 'transfer-'))
  try {
    // Unix modes do not restrict NTFS. Remove inherited access before writing CSV.
    const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 })
    const sid = stdout.match(/S-1-5-[0-9-]+/)
    if (!sid) throw new Error('Current Windows identity is unavailable')
    await execute('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid[0]}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 10000 })
    return directory
  } catch {
    await fs.rm(directory, { recursive: true, force: true })
    throw apiError('STORAGE_UNAVAILABLE', 'A private native password transfer directory could not be created')
  }
}

function createNativePasswordTransfer ({ root, platform = process.platform, dialog = nativeDialog, makeDirectory = privateDirectory, cleanupWaitMs = 120000, cleanupGraceMs = 5000 } = {}) {
  let pendingClose = null
  const recover = async () => {
    let entries
    try { entries = await fs.readdir(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (!/^transfer-[A-Za-z0-9]{6}$/.test(entry.name)) continue
      const directory = path.join(root, entry.name)
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw apiError('STORAGE_UNAVAILABLE', 'Unsafe native password transfer recovery directory')
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  // Recovery is started on runtime activation, not deferred until another transfer.
  const recovery = platform === 'win32' && root ? recover().then(() => null, () => apiError('STORAGE_UNAVAILABLE', 'Interrupted native password transfer cleanup failed')) : Promise.resolve(null)
  return async ({ engine, tabs, pid, kind, plain, signal, progress, check }) => {
    if (platform !== 'win32') throw apiError('NOT_SUPPORTED_BY_ENGINE', 'Native password file transfer currently requires Windows')
    if (!Number.isSafeInteger(pid) || pid <= 0) throw apiError('CAPABILITY_MISSING', 'The managed browser process identity is unavailable')
    if (pendingClose) throw apiError('BUSY', 'Dismiss Windows Security for the previous password transfer before starting another')
    const recoveryError = await recovery
    if (recoveryError) throw recoveryError
    if ((await dialog({ pid, operation: kind, action: 'inspect' }, signal)).acted) throw apiError('BUSY', 'Close the existing browser file dialog before starting a password transfer')
    const directory = await makeDirectory(root)
    const file = path.join(directory, 'passwords.csv')
    let tabId
    let selecting = false
    let pendingInput = null
    let outputPlain = null
    let awaitingApproval = false
    const bound = async promise => {
      let timer
      let listener
      try {
        return await Promise.race([
          promise,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(apiError('TIMEOUT', 'Native browser command timed out')), 10000)
            listener = () => reject(aborted())
            signal.addEventListener('abort', listener, { once: true })
            if (signal.aborted) listener()
          })
        ])
      } finally { clearTimeout(timer); if (listener) signal.removeEventListener('abort', listener) }
    }
    const send = (method, params) => bound(tabs.send(tabId, method, params))
    const checkPage = () => {
      const current = tabs.get(tabId).url
      const allowed = engine === 'edge' ? ['edge://settings/autofill/passwords', 'edge://wallet/passwords'] : ['chrome://password-manager/settings']
      if (!allowed.includes(current)) throw apiError('POLICY_DENIED', 'Native password page changed; transfer stopped')
    }
    const nodes = async () => {
      checkPage()
      return (await send('Accessibility.getFullAXTree', {})).nodes || []
    }
    const click = async (pattern, optional = false, asynchronous = false) => {
      await check()
      if (signal.aborted) throw aborted()
      const node = (await nodes()).find(node => !node.ignored && ['button', 'menuitem'].includes(node.role && node.role.value) && pattern.test((node.name && node.name.value) || ''))
      if (!node) {
        if (optional) return false
        throw apiError('CAPABILITY_MISSING', 'Native password control is unavailable in this browser version or language')
      }
      const { model } = await send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })
      if (!model || model.width <= 0 || model.height <= 0) throw apiError('ELEMENT_NOT_ACTIONABLE', 'Native password control is not visible')
      const q = model.content
      const point = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' })
      const released = tabs.send(tabId, 'Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' })
      if (asynchronous) {
        // Chrome may hold the input acknowledgement until Windows reauthentication.
        pendingInput = released.then(() => null, () => apiError('NATIVE_DIALOG_FAILED', 'Native export input failed'))
      } else await bound(released)
      return true
    }
    try {
      await check()
      if (signal.aborted) throw aborted()
      if (kind === 'import') await fs.writeFile(file, plain, { flag: 'wx', mode: 0o600 })
      const opened = await bound(tabs.newTab({ url: engine === 'edge' ? 'edge://settings/autofill/passwords' : 'chrome://password-manager/settings', activate: true }))
      tabId = opened.tab.tabId
      await sleep(1000)
      if (engine === 'edge') { await click(/^show more$/i); await sleep(300) }
      if (kind === 'import') {
        if (engine === 'edge') { await click(/^Import passwords$/i); await sleep(300) }
        await click(/^(Select file|Choose CSV file|Choose file)$/i)
        selecting = true
        progress('waiting_for_file_dialog')
      } else {
        awaitingApproval = true
        progress('waiting_for_windows_approval')
        await click(/^(Download file|Export passwords)$/i, false, engine === 'chrome')
        if (engine === 'edge') { await sleep(300); await click(/^Export$/i, false, true) }
        selecting = true
      }
      const end = Date.now() + 120000
      let selected = false
      let observedError
      if (pendingInput) pendingInput.then(error => { observedError = error })
      while (Date.now() < end) {
        if (signal.aborted) throw aborted()
        await check()
        checkPage()
        if (observedError) throw observedError
        if (!selected) {
          const result = await dialog({ pid, path: file, operation: kind, action: 'select' }, signal)
          if (result.acted) { selected = true; awaitingApproval = false; progress('waiting_for_browser'); selecting = false }
        }
        if (selected && kind === 'import') {
          const text = (await nodes()).filter(node => !node.ignored).map(node => node.name && node.name.value ? node.name.value : '').join('\n')
          if (/import successful|passwords? imported (?:successfully|to )/i.test(text)) {
            return { imported: true }
          }
          if (/couldn.t import|failed to import|import failed|could not import/i.test(text)) throw apiError('IMPORT_FAILED', 'The browser rejected the password CSV')
        }
        if (selected && kind === 'export') {
          checkPage()
          try {
            const stat = await fs.lstat(file)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw apiError('INVALID_REQUEST', 'Native password export is not a valid bounded file')
            if (stat.size > 0) {
              const plain = await fs.readFile(file)
              try {
                await sleep(300)
                const after = await fs.stat(file)
                if (after.size === stat.size && after.mtimeMs === stat.mtimeMs) { outputPlain = plain; return { plain } }
              } finally { if (outputPlain !== plain) plain.fill(0) }
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        await sleep(500)
      }
      throw apiError('TIMEOUT', 'Native password transfer timed out; Windows approval may still be required')
    } finally {
      const cleanupErrors = []
      if (selecting) {
        try { await dialog({ pid, operation: kind, action: 'cancel' }) } catch (error) { cleanupErrors.push(error) }
      }
      try {
        const stat = await fs.lstat(file)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_BYTES) await fs.writeFile(file, Buffer.alloc(stat.size))
      } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error) }
      try { await fs.rm(directory, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
      // Windows Security has no browser owner HWND. Never cancel it by title or
      // timing: another application's credentials could be awaiting consent.
      if (tabId) {
        const closing = Promise.resolve().then(() => tabs.close(tabId)).then(
          () => ({ closed: true }),
          () => ({ closed: false })
        )
        let timer
        let result
        try {
          result = await Promise.race([closing, new Promise(resolve => { timer = setTimeout(() => resolve(null), cleanupGraceMs) })])
        } finally { clearTimeout(timer) }
        if (!result && awaitingApproval) {
          pendingClose = closing
          closing.then(() => { if (pendingClose === closing) pendingClose = null })
          if (!cleanupErrors.length) {
            progress('waiting_for_windows_dismissal')
            try {
              result = await Promise.race([closing, new Promise(resolve => { timer = setTimeout(() => resolve(null), cleanupWaitMs) })])
            } finally { clearTimeout(timer) }
            if (!result) cleanupErrors.push(apiError('NATIVE_APPROVAL_REQUIRED', 'Dismiss Windows Security on the device desktop. Password data was removed; the dedicated settings tab will close after dismissal. New password transfers remain blocked until then.'))
          }
        }
        if ((!result || !result.closed) && !cleanupErrors.some(error => error.code === 'NATIVE_APPROVAL_REQUIRED')) cleanupErrors.push(apiError('CLEANUP_FAILED', 'Native password tab cleanup did not complete'))
      }
      await reportCleanup(cleanupErrors, outputPlain)
    }
  }
}

async function reportCleanup (errors, plain) {
  if (!errors.length) return
  if (plain) plain.fill(0)
  if (errors.length === 1 && errors[0].code === 'NATIVE_APPROVAL_REQUIRED') throw errors[0]
  throw apiError('CLEANUP_FAILED', 'Native transfer cleanup did not complete; close the browser password dialog and check the device transfer directory')
}

module.exports = { createNativePasswordTransfer, nativeDialog }
