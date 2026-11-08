const { spawn } = require('node:child_process')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')
const { normalizeClientInventory } = require('./client-inventory-schema')
const MAX_OUTPUT = 128 * 1024

function script () {
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Clean([string]$value) { if ($null -eq $value) { return '' }; $value = ($value -replace '[\x00-\x1f\x7f]', ' ' -replace '\s+', ' ').Trim(); if ($value.Length -gt 160) { $value = $value.Substring(0,160).Trim() }; return $value }
$result = @{ version = 1; status = 'ok'; collectedAt = $null; role = $null; security = @{ status = 'unavailable'; products = @() }; software = @{ status = 'unavailable'; scope = 'machine+current-user'; truncated = $false; items = @() } }
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($identity.IsSystem) { $result.role = 'system' } elseif ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $result.role = 'admin' } else { $result.role = 'user' }
} catch { $result.status = 'error' }
try {
  $products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -OperationTimeoutSec 5 | ForEach-Object {
    $name = Clean $_.displayName
    if (-not $name) { return }
    $hex = '{0:x6}' -f [int]$_.productState
    $flag = $hex.Substring(2, 2)
    [pscustomobject]@{ name = $name; enabled = ($flag -eq '10' -or $flag -eq '11') }
  })
  $result.security = @{ status = 'ok'; products = @($products | Sort-Object name -Unique | Select-Object -First 32) }
} catch {
  try {
    $defender = Get-MpComputerStatus -ErrorAction Stop
    $result.security = @{ status = 'ok'; products = @(@{ name = 'Microsoft Defender Antivirus'; enabled = [bool]$defender.AntivirusEnabled }) }
  } catch { $result.security.status = 'unavailable' }
}
if (-not $result.security.products -or @($result.security.products).Count -eq 0) {
  try {
    $defender = Get-MpComputerStatus -ErrorAction Stop
    $result.security = @{ status = 'ok'; products = @(@{ name = 'Microsoft Defender Antivirus'; enabled = [bool]$defender.AntivirusEnabled }) }
  } catch {}
}
try {
  $result.ipv4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress -Unique | Select-Object -First 8)
} catch { $result.ipv4 = @() }
$apps = @{}
$failed = $false
$keys = @('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
foreach ($key in $keys) {
  try {
    if (-not (Test-Path -LiteralPath $key)) { continue }
    foreach ($entry in @(Get-ChildItem -LiteralPath $key -ErrorAction Stop)) {
      try {
        $app = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction Stop
        $name = Clean $app.DisplayName
        if ($name -and $app.SystemComponent -ne 1 -and -not $app.ParentKeyName) { $version = Clean $app.DisplayVersion; $apps[$name + '|' + $version] = @{ name = $name; version = $version } }
      } catch { $failed = $true }
    }
  } catch { $failed = $true }
}
$all = @($apps.Values | Sort-Object { $_.name }, { $_.version })
$result.software.items = @($all | Select-Object -First 100)
$result.software.truncated = $all.Count -gt 100
$result.software.status = if ($failed) { 'error' } else { 'ok' }
if ($result.security.status -ne 'ok' -or $result.software.status -ne 'ok') { $result.status = 'unavailable' }
[Console]::Out.WriteLine('ANUBIS_CLIENT_INVENTORY ' + (ConvertTo-Json -InputObject $result -Depth 6 -Compress))
`
}

function createClientInventory ({ platform = process.platform, env = process.env, spawn: launch = spawn, now = Date.now, timeoutMs = 20000, ttlMs = 15 * 60 * 1000, onError = error => console.warn('Client inventory collection failed:', error.code || 'COLLECTOR_FAILED') } = {}) {
  const empty = status => ({
    version: 1,
    status,
    collectedAt: null,
    role: null,
    security: { status, products: [] },
    software: { status, scope: platform === 'win32' ? 'machine+current-user' : 'unsupported', truncated: false, items: [] }
  })
  let value = empty(platform === 'win32' ? 'collecting' : 'unavailable')
  let pending
  let refreshedAt = -Infinity
  function refresh () {
    if (pending) return pending
    if (platform !== 'win32') return Promise.resolve(value)
    refreshedAt = now()
    value = { ...value, status: 'collecting' }
    const root = env.SystemRoot && path.win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows'
    const system = process.arch === 'ia32' && env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32'
    const command = path.win32.join(root, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    pending = new Promise(resolve => {
      let child
      let finished = false
      let timer = null
      let output = ''
      let size = 0
      const decoder = new StringDecoder('utf8')
      const finish = (error, raw) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (error) {
          onError(error)
          value = { ...value, status: error.code === 'TIMEOUT' ? 'timeout' : 'error' }
        } else value = normalizeClientInventory({ ...raw, collectedAt: now() })
        resolve(value)
      }
      try {
        child = launch(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script(), 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { finish(error); return }
      timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Client inventory deadline exceeded'), { code: 'TIMEOUT' })) }, timeoutMs)
      child.once('error', error => finish(error))
      child.stderr.on('data', chunk => {
        size += chunk.length
        if (size > MAX_OUTPUT) { child.kill(); finish(Object.assign(new Error('Client inventory output exceeds limit'), { code: 'OUTPUT_LIMIT' })) }
      })
      child.stdout.on('data', chunk => {
        size += chunk.length
        if (size > MAX_OUTPUT) { child.kill(); finish(Object.assign(new Error('Client inventory output exceeds limit'), { code: 'OUTPUT_LIMIT' })); return }
        output += decoder.write(chunk)
      })
      child.once('close', code => {
        if (finished) return
        try {
          if (code !== 0) throw new Error('Client inventory process failed')
          output += decoder.end()
          const line = output.split(/\r?\n/).find(line => line.startsWith('ANUBIS_CLIENT_INVENTORY '))
          if (!line) throw new Error('Client inventory output missing')
          const raw = JSON.parse(line.slice('ANUBIS_CLIENT_INVENTORY '.length))
          normalizeClientInventory(raw)
          finish(null, raw)
        } catch (error) { finish(error) }
      })
    }).finally(() => { pending = undefined })
    return pending
  }
  return {
    get () {
      if (now() - refreshedAt >= (['error', 'timeout'].includes(value.status) ? 60000 : ttlMs)) refresh()
      return value
    },
    wait: refresh
  }
}

let shared
function getClientInventory () {
  if (!shared) shared = createClientInventory()
  return shared.get()
}
function localIpv4 () {
  const found = []
  for (const entries of Object.values(require('node:os').networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family
      if (family !== 'IPv4' && family !== 4) continue
      if (entry.internal || typeof entry.address !== 'string') continue
      if (entry.address.startsWith('127.') || entry.address.startsWith('169.254.')) continue
      if (!found.includes(entry.address)) found.push(entry.address)
      if (found.length >= 8) return found
    }
  }
  return found
}
let cachedMachineGuid
function machineGuid () {
  if (cachedMachineGuid !== undefined) return cachedMachineGuid
  cachedMachineGuid = ''
  if (process.platform !== 'win32') return cachedMachineGuid
  try {
    const output = require('node:child_process').execFileSync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = output.split(/\r?\n/).find(item => item.includes('MachineGuid'))
    const value = line && /REG_\w+\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i.exec(line)
    if (value) cachedMachineGuid = value[1].toLowerCase()
  } catch {}
  return cachedMachineGuid
}
function getManagedInventory () {
  const client = getClientInventory()
  const ipv4 = [...new Set([...(Array.isArray(client.ipv4) ? client.ipv4 : []), ...localIpv4()])].slice(0, 8)
  return { ...require('@ai-security-tool/managed-access/hardware-inventory').getHardwareInventory(), machineGuid: machineGuid(), client: { ...client, ipv4 } }
}
module.exports = { createClientInventory, normalizeClientInventory, getClientInventory, getManagedInventory, machineGuid, script }
