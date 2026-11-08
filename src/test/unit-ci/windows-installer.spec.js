const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const brand = require('../../common/brand.config')
const config = require('../../build/electron-builder.json')
const include = fs.readFileSync(path.resolve(__dirname, '../../build/windows-installer.nsh'), 'utf8')

describe('Windows installer contract', () => {
  it('registers exactly the branded OS protocols, without legacy parser aliases', () => {
    const schemes = config.protocols.flatMap(protocol => protocol.schemes).sort()
    assert.deepEqual(schemes, [brand.protocol.custom, ...brand.protocol.extra].sort())
    for (const legacy of brand.protocol.legacyCustom) {
      assert.ok(!schemes.includes(legacy))
    }
  })

  it('elevates only the installer, before process creation completes', () => {
    assert.equal(config.win.requestedExecutionLevel, 'asInvoker')
    assert.equal(config.nsis.include, 'src/build/windows-installer.nsh')
    assert.match(include, /!macro customHeader[\s\S]*?!ifndef BUILD_UNINSTALLER\s+RequestExecutionLevel admin\s+SilentInstall normal/)
    assert.match(include, /!ifdef BUILD_UNINSTALLER\s+RequestExecutionLevel admin/)
    assert.doesNotMatch(include, /UAC_RunElevated|ExecShell.*runas/i)
  })

  it('requires canonical per-machine installation and explicitly preserves app data', () => {
    assert.equal(config.nsis.oneClick, false)
    assert.equal(config.nsis.perMachine, true)
    assert.equal(config.nsis.allowToChangeInstallationDirectory, false)
    assert.equal(config.nsis.runAfterFinish, false)
    assert.equal(config.nsis.deleteAppDataOnUninstall, false)
    assert.match(include, /!define \/ifndef ANUBIS_MACHINE_LEAF "Anubis-Security-Tool"/)
    assert.match(include, /StrCpy \$INSTDIR "\$PROGRAMFILES64\\\$\{ANUBIS_MACHINE_LEAF\}"/)
    assert.match(include, /ReadRegStr \$0 HKCU/)
    assert.match(include, /Automatic migration is refused/)
    assert.match(include, /\$\{isDeleteAppData\}[\s\S]+SetErrorLevel 87/)
  })

  it('supports console output, explicit errors and only verified success', () => {
    assert.match(include, /\$\{GetOptions\} \$R0 "--console"/)
    assert.match(include, /WriteConsoleW/)
    assert.match(include, /WriteFile/)
    assert.match(include, /SetErrorLevel 1/)
    assert.match(include, /Function \.onInstSuccess\s+SetErrorLevel 0/)
    assert.match(include, /customUnInstallCheckCurrentUser/)
    assert.match(include, /SetErrorLevel \$R0/)
    for (const arch of ['x64', 'ia32', 'arm64']) {
      assert.match(include, new RegExp(`!macro customFiles_${arch}\\s+!insertmacro AnubisCheckCopiedFiles`))
    }
    assert.match(include, /AnubisVerifyCopiedFile "resources\\app.asar"/)
    assert.match(include, /AnubisVerifyCopiedFile "anubis-host.exe"/)
    assert.match(include, /AnubisMachineAction Finish/)
    for (const line of include.split(/\r?\n/).filter(line => /^\s*MessageBox\b/.test(line))) {
      assert.match(line, /\/SD IDOK$/, 'Silent errors must not block on a dialog: ' + line)
    }
  })

  it('defaults to a visible install and flips to silent only on the --silent flag', () => {
    // Fleet auto-update + canary drive the installer with `--silent`; the GUI
    // default must stay visible (`normal`) and switch to silent solely via that
    // flag in preInit. This is the fleet-critical path the poller depends on.
    assert.match(include, /!macro preInit\s+SetSilent normal/)
    assert.match(
      include,
      /\$\{GetOptions\} \$R0 "--silent" \$R1\s+\$\{IfNot\} \$\{Errors\}\s+SetSilent silent\s+\$\{EndIf\}/
    )
    // The default `normal` must precede the conditional `silent` flip.
    assert.ok(include.indexOf('SetSilent normal') < include.indexOf('SetSilent silent'))
  })

  it('creates the desktop shortcut only on an interactive opt-in, never silently or on update', () => {
    // electron-builder must never auto-create the desktop shortcut; the Start
    // Menu shortcut stays enabled (createStartMenuShortcut is left at default).
    assert.equal(config.nsis.createDesktopShortcut, false)
    assert.ok(!('createStartMenuShortcut' in config.nsis) || config.nsis.createStartMenuShortcut !== false)
    // The opt-in checkbox defaults to unchecked and only an interactive assisted
    // page can flip it; the page is skipped for silent installs. The update guard
    // lives in customInstall (the ${isUpdated} macro needs the StdUtils plugin,
    // which is unavailable where the page function is included).
    assert.match(include, /StrCpy \$AnubisDesktopShortcut 0/)
    assert.match(
      include,
      /!macro customPageAfterChangeDir\s+Page custom AnubisShortcutPageCreate AnubisShortcutPageLeave\s+!macroend/
    )
    assert.match(
      include,
      /Function AnubisShortcutPageCreate[\s\S]*?\$\{If\} \$\{Silent\}\s+Abort\s+\$\{EndIf\}/
    )
    assert.match(include, /\$\{NSD_CreateCheckbox\} 0 20u 100% 12u "Create a desktop shortcut"/)
    assert.match(include, /Function AnubisShortcutPageLeave\s+\$\{NSD_GetState\} \$AnubisDesktopCheckbox \$AnubisDesktopShortcut/)
    // The shortcut is written only when not silent, not an update, and ticked.
    assert.match(
      include,
      /\$\{IfNot\} \$\{Silent\}\s+\$\{IfNot\} \$\{isUpdated\}\s+\$\{If\} \$AnubisDesktopShortcut == 1\s+CreateShortCut "\$DESKTOP\\\$\{PRODUCT_NAME\}\.lnk" "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/
    )
    // The uninstaller removes the shortcut on a real uninstall (not on update).
    assert.match(include, /!insertmacro AnubisMachineAction Remove\s+Delete "\$DESKTOP\\\$\{PRODUCT_NAME\}\.lnk"/)
  })

  it('invokes native x64 PowerShell from both 32-bit NSIS deployment paths', () => {
    const commands = include.split(/\r?\n/).filter(line => /nsExec::ExecToLog/.test(line))
    assert.equal(commands.length, 2)
    for (const command of commands) {
      assert.ok(command.includes('"$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"'))
    }
    const script = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-install.ps1'), 'utf8')
    assert.match(script, /if \(-not \[Environment\]::Is64BitProcess\) \{ throw 'Machine installation requires native x64 PowerShell' \}/)
  })

  it('resolves the native KnownFolder through Sysnative from a real x86 process without deployment', {
    skip: process.platform !== 'win32',
    timeout: 30000
  }, () => {
    const systemRoot = process.env.SystemRoot
    const quote = value => "'" + value.replace(/'/g, "''") + "'"
    const encode = value => Buffer.from(value, 'utf16le').toString('base64')
    const script = path.resolve(__dirname, '../../build/windows-machine-install.ps1')
    const probe = `$ProgressPreference='SilentlyContinue'; . ${quote(script)} -DefinitionsOnly; [pscustomobject]@{process64=[Environment]::Is64BitProcess;programFiles=(Get-NativeProgramFiles)} | ConvertTo-Json -Compress`
    const nativePowerShell = path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const bridge = `$ProgressPreference='SilentlyContinue'; & ${quote(nativePowerShell)} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encode(probe)}; exit $LASTEXITCODE`
    const result = spawnSync(path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(bridge)
    ], { encoding: 'utf8', timeout: 25000, windowsHide: true })
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    const value = JSON.parse(result.stdout.trim())
    assert.equal(value.process64, true)
    assert.ok(path.isAbsolute(value.programFiles))
    assert.ok(fs.statSync(value.programFiles).isDirectory())
  })

  it('waits for normal exit and never force-closes existing sessions', () => {
    assert.match(include, /!macro customCheckAppRunning/)
    assert.match(include, /StrCpy \$R2 120/)
    assert.match(include, /Sleep 500/)
    assert.match(include, /SetErrorLevel 1618/)
    assert.doesNotMatch(include, /_KillProcess|_CloseProcess|taskkill|Stop-Process|KILL_PROCESS/i)
  })

  it('never leaves the machine host stopped when setup aborts after taking it down', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-install.ps1'), 'utf8')
    // The abort handler must restore the owned service, but only once and only
    // when a Prepare/Stop already took it down, before quitting.
    assert.match(
      include,
      /Function AnubisFail\s+;[\s\S]*?\$\{If\} \$AnubisServiceStopped == 1\s+StrCpy \$AnubisServiceStopped 0\s+!insertmacro AnubisMachineAction Start\s+\$\{EndIf\}/
    )
    // The down-state flag is armed right after each service stop.
    assert.match(include, /!insertmacro AnubisMachineAction Prepare\s+StrCpy \$AnubisServiceStopped 1/)
    assert.match(include, /!else\s+StrCpy \$AnubisServiceStopped 1\s+StrCpy \$AnubisMessage "Waiting up to 60 seconds/)
    assert.match(include, /StrCpy \$AnubisServiceStopped 0\s+\$\{GetParameters\}/)
    // The recovery action is best-effort: it never validates package state and
    // always exits 0, so it can never re-enter the abort path.
    assert.match(script, /\[ValidateSet\('Prepare', 'Stop', 'Finish', 'Remove', 'UninstallPrevious', 'Start', 'ReleasePackage'\)\]/)
    assert.match(script, /if \(\$Action -eq 'Start'\) \{[\s\S]*?Invoke-Host @\('arm', '--name', \$ServiceName\)[\s\S]*?Start-Service -Name \$ServiceName -ErrorAction SilentlyContinue[\s\S]*?exit 0/)
  })

  it('derives interactive operator SIDs only for production, empty, retained lists', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../build/windows-machine-install.ps1'), 'utf8')
    // Default derivation is gated: no explicit list, production edition, and an
    // empty/absent retained list. Explicit /ALLOWUSERSIDS stays authoritative.
    assert.match(script, /\$AllowedUserSids -eq '' -and -not \$CompiledEdition\.disableManaged -and \(Test-RetainedAllowListEmpty\)/)
    assert.match(script, /\$derived = @\(Get-InteractiveUserSids\)/)
    // Interactive enumeration keeps only canonical account SIDs (type 2/10/11).
    assert.match(script, /LogonType -in @\(2, 10, 11\)/)
    assert.match(script, /\^S-1-5-21-\[0-9\]\+-\[0-9\]\+-\[0-9\]\+-\[0-9\]\+\$/)
    // One-time empty-list migration recreates the stopped service; a populated
    // retained list is still refused.
    assert.match(script, /if \(Test-RetainedAllowListEmpty\) \{[\s\S]*?Invoke-Host @\('uninstall', '--name', \$ServiceName\)[\s\S]*?--allow-user-sids/)
    assert.match(script, /The retained service allow-list cannot be changed by an update/)
  })

  it('filters, dedups and sorts candidate account SIDs canonically', {
    skip: process.platform !== 'win32',
    timeout: 30000
  }, () => {
    const systemRoot = process.env.SystemRoot
    const quote = value => "'" + value.replace(/'/g, "''") + "'"
    const encode = value => Buffer.from(value, 'utf16le').toString('base64')
    const script = path.resolve(__dirname, '../../build/windows-machine-install.ps1')
    const candidates = [
      'S-1-5-21-9-9-9-1001', 'S-1-5-18', 'S-1-5-21-1-2-3-500',
      's-1-5-21-1-2-3-500', 'S-1-5-21-1-2-3-500', 'garbage', ''
    ]
    const list = candidates.map(quote).join(',')
    const probe = `$ProgressPreference='SilentlyContinue'; . ${quote(script)} -DefinitionsOnly; [string]::Join(',', (Select-CanonicalAccountSids @(${list})))`
    const nativePowerShell = path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const runner = fs.existsSync(nativePowerShell)
      ? nativePowerShell
      : path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(runner, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(probe)
    ], { encoding: 'utf8', timeout: 25000, windowsHide: true })
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.stdout.trim(), 'S-1-5-21-1-2-3-500,S-1-5-21-9-9-9-1001')
  })

  it('repairs a stale service before querying a helper in an absent package', {
    skip: process.platform !== 'win32',
    timeout: 30000
  }, () => {
    const script = path.resolve(__dirname, '../../build/windows-machine-install.ps1')
    const probe = `
. '${script.replace(/'/g, "''")}' -DefinitionsOnly
$Action = 'Prepare'
$InstallDir = Join-Path $env:TEMP ('anubis-absent-' + [Guid]::NewGuid().ToString('N'))
function Read-AllowedUserSids { return 'S-1-5-21-1-2-3-500' }
function Assert-Destination {}
function Invoke-UserMigration {}
function Get-OwnedService { throw 'Queried helper before repairing absent package' }
function Repair-StaleCanonicalService { throw 'STALE_REPAIR_REACHED' }
try { Invoke-MachineInstall; throw 'Missing repair' }
catch {
  if ($_.Exception.Message -cne 'STALE_REPAIR_REACHED') { throw }
  Write-Output 'STALE_REPAIR_REACHED'
}
`
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')
    ], { encoding: 'utf8', timeout: 25000, windowsHide: true })
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.stdout.trim(), 'STALE_REPAIR_REACHED')
  })
})
