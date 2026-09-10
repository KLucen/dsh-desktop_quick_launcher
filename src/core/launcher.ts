/**
 * Pure launcher generation — migrated from @linxin666/dsh-desktop-launcher
 * (src/core/launcher.ts, Apache-2.0) and extended in v0.2.
 *
 * Produces, with no filesystem or process access (everything is testable):
 *  - the Windows launcher body (tiered probe, single-instance mutex, captured
 *    child stdout/stderr, machine-readable status file, classified messages);
 *  - the POSIX launcher body (macOS .command / Linux .sh);
 *  - the Windows restart helper that supervises a restart from OUTSIDE the
 *    host process tree;
 *  - the Windows shortcut installer;
 *  - the shared probe/status PowerShell fragments the two Windows scripts use.
 *
 * v0.2 changes vs. the v0.1 body:
 *  - `Test-DshUrl` (2xx–4xx == ready) is replaced by a tiered probe that can
 *    tell "DSH is up" from "a foreign server holds the port" from "something
 *    accepts TCP but never answers".
 *  - the child is started with -RedirectStandardOutput/-RedirectStandardError,
 *    so an early exit finally has a reason attached; the tail goes into both
 *    the message box and the status file.
 *  - every run writes launcher-status.json (atomic temp+rename, UTF-8 no BOM).
 *  - a named mutex serializes concurrent launcher invocations.
 */

/** Desktop platforms the launcher can generate an icon for. */
export type LauncherPlatform = 'win32' | 'darwin' | 'linux'

/** Launcher behavior, resolved from plugin config. */
export interface LauncherSpec {
  /** Command that starts dsh (must be on PATH when the launcher runs). */
  dshCommand: string
  /** Base URL of the dsh web GUI. */
  url: string
  /** Listen port the probe targets; normally `ctx.webServer.port`. */
  port: number
  /** Optional profile started as `dsh --profile <profile> --no-open`. */
  profile?: string
  /** Optional icon file (.ico/.png); empty uses the bundled dsh icon. */
  iconPath?: string
}

/** Everything the generated restart helper needs, baked into the script. */
export interface RestartSpec {
  /** Listen port of the host being restarted. */
  port: number
  /** GUI URL (probe target). */
  url: string
  /** PID of the host that requested the restart. */
  hostPid: number
  /** How long to leave the host alone before checking whether it exited. */
  graceMs: number
  /** Command that starts dsh. */
  dshCommand: string
  /** Optional profile. */
  profile?: string
  /** Identity of the instance that requested the restart (readiness proof). */
  instanceIdBefore: string
  /** Readiness budget in seconds. */
  waitSeconds: number
  /**
   * Working directory the replacement must start in. A scheduled task starts in
   * `%SystemRoot%\System32`, so this has to be restored explicitly — otherwise
   * the new host comes up with the wrong workspace.
   */
  cwd: string
  /**
   * DSH home to export for the replacement. A scheduled task inherits the user
   * environment, which may not carry a custom `DSH_HOME`.
   */
  dshHome: string
}

/** Default dsh command. */
export const DEFAULT_DSH_COMMAND = 'dsh'

/** Default GUI URL. */
export const DEFAULT_URL = 'http://127.0.0.1:3080'

/** Default listen port. */
export const DEFAULT_PORT = 3080

/** Default grace period between the 202 acknowledgement and the host's exit. */
export const DEFAULT_GRACE_MS = 1500

/** Default readiness budget in seconds (launcher and helper). */
export const DEFAULT_WAIT_SECONDS = 150

/** Same-origin route prefix; the single source of truth for both halves. */
export const PLUGIN_ROUTE_PREFIX = '/api/dsh-desktop_quick_launcher'

/** File names written next to the launcher script under <dsh-home>/. */
export const LAUNCHER_FILES = {
  launcherScript: 'launcher.ps1',
  restartHelper: 'restart-helper.ps1',
  shortcutInstaller: 'install-shortcut.ps1',
  launcherLog: 'launcher.log',
  helperLog: 'restart-helper.log',
  childOut: 'dsh-child.out.log',
  childErr: 'dsh-child.err.log',
  launcherStatus: 'launcher-status.json',
  restartStatus: 'restart-status.json',
  restartInflight: 'restart-inflight.json',
  authUrl: 'auth-url.txt',
  icon: 'dsh.ico',
  iconPng: 'dsh.png',
} as const

/** Port implied by a URL, falling back to the plugin default. */
export function portFromUrl(url: string, fallback: number = DEFAULT_PORT): number {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number(parsed.port)
    if (parsed.protocol === 'https:') return 443
    if (parsed.protocol === 'http:') return 80
  } catch { /* fall through */ }
  return fallback
}

/** Resolve defaults from a partial config; empty profile means "no --profile flag". */
export function resolveLauncherSpec(config: {
  dshCommand?: string
  url?: string
  port?: number
  profile?: string
  iconPath?: string
}): LauncherSpec {
  const url = config.url ?? DEFAULT_URL
  return {
    dshCommand: config.dshCommand ?? DEFAULT_DSH_COMMAND,
    url,
    port: config.port ?? portFromUrl(url),
    ...(config.profile === undefined || config.profile === '' ? {} : { profile: config.profile }),
    ...(config.iconPath === undefined || config.iconPath === '' ? {} : { iconPath: config.iconPath }),
  }
}

/** File name of the launcher script under <dsh-home>/desktop-quick-launcher/. */
export function scriptFileName(platform: LauncherPlatform): string {
  switch (platform) {
    case 'win32': return LAUNCHER_FILES.launcherScript
    case 'darwin': return 'launcher.command'
    case 'linux': return 'launcher.sh'
  }
}

/** File name of the icon placed on the Desktop. */
export function desktopFileName(platform: LauncherPlatform): string {
  switch (platform) {
    case 'win32': return 'DSH-Web.lnk'
    case 'darwin': return 'DeepSeek-Harness.command'
    case 'linux': return 'deepseek-harness.desktop'
  }
}

/** Arguments used to run a generated PowerShell script hidden. */
export const HIDDEN_POWERSHELL_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'] as const

/**
 * Build the `schtasks /tr` command line for the restart helper.
 *
 * The value is handed to `schtasks` as ONE argument (argv, no shell), so only
 * the paths that contain spaces need quoting — but quoting them is essential,
 * since a `DSH_HOME` with a space would otherwise split the command line and
 * `schtasks` would reject the parameters (observed as
 * `Invalid argument/option - '-NoProfile'`).
 * @param helperPath - absolute path of the generated restart helper.
 * @returns the command line to store in the task.
 */
export function renderScheduledTaskCommand(helperPath: string): string {
  const args = [...HIDDEN_POWERSHELL_ARGS, '-File', helperPath]
  return `powershell.exe ${args.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`
}

/** Single-quote a value for PowerShell (embedded quotes are doubled). */
function psSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Single-quote a value for POSIX sh (embedded quotes are escaped). */
function shSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// ---------------------------------------------------------------------------
// shared PowerShell fragments
// ---------------------------------------------------------------------------

/**
 * The tiered probe, shared by the launcher and the restart helper.
 *
 * The caller must define: `$url`, `$port`, `$pingPath`, `$pluginId`,
 * `$fingerprint`, `$childOut`, `$childErr`, and `Write-Log`.
 *
 * Tiers: TCP connect (is anything there?) → plugin `/ping` (is it DSH with this
 * plugin? gives the instanceId) → `/` with the DSH authentication body (is it
 * DSH without the plugin?) → foreign / unresponsive.
 */
export function renderProbeFunctions(): string {
  return [
    'function Test-TcpPort {',
    '  param([int]$ProbePort)',
    '  $client = $null',
    '  try {',
    '    $client = New-Object System.Net.Sockets.TcpClient',
    "    $async = $client.BeginConnect('127.0.0.1', $ProbePort, $null, $null)",
    '    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }',
    '    $client.EndConnect($async)',
    '    return $true',
    '  } catch {',
    '    return $false',
    '  } finally {',
    '    if ($client -ne $null) { try { $client.Close() } catch {} }',
    '  }',
    '}',
    '',
    'function Get-HttpProbe {',
    '  param([string]$Uri, [int]$TimeoutSec)',
    "  $probe = @{ reachable = $true; status = 0; body = '' }",
    '  try {',
    '    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec $TimeoutSec',
    '    $probe.status = [int]$response.StatusCode',
    '    $probe.body = [string]$response.Content',
    '  } catch {',
    '    $webResponse = $_.Exception.Response',
    '    if ($webResponse -ne $null -and $webResponse.StatusCode -ne $null) {',
    '      $probe.status = [int]$webResponse.StatusCode',
    '      try {',
    '        $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())',
    '        $probe.body = $reader.ReadToEnd()',
    '        $reader.Close()',
    '      } catch {}',
    '    } else {',
    '      $probe.reachable = $false',
    '    }',
    '  }',
    '  return $probe',
    '}',
    '',
    'function Test-GuiReady {',
    '  param($Probe)',
    '  # A 200 from /ping only proves this plugin route is live. Until the SPA',
    '  # fallback registers, the server answers 404 for everything unclaimed, so a',
    '  # browser opened too early shows "HTTP ERROR 404" until a manual refresh.',
    '  # Require the real page (or the token exchange) before calling it ready.',
    "  if ($Probe -ne $null -and $Probe.authUrl -ne '') {",
    '    $token = Get-HttpProbe $Probe.authUrl 3',
    '    if ($token.status -ge 200 -and $token.status -lt 400) { return $true }',
    '  }',
    '  $root = Get-HttpProbe $url 3',
    '  if ($root.status -eq 401 -and $root.body.Contains($fingerprint)) { return $true }',
    '  if ($root.status -ge 200 -and $root.status -lt 400) { return $true }',
    '  return $false',
    '}',
    '',
    'function Get-Probe {',    "  $result = @{ probeClass = 'down'; status = 0; instanceId = ''; authRequired = $false; authUrl = '' }",
    '  if (-not (Test-TcpPort $port)) { return $result }',
    "  $pingUri = $url.TrimEnd('/') + $pingPath",
    '  $ping = Get-HttpProbe $pingUri 2',
    '  if ($ping.reachable -and $ping.status -eq 200 -and $ping.body.Contains($pluginId)) {',
    '    $result.status = 200',
    "    $idMatch = [regex]::Match($ping.body, '\"instanceId\"\\s*:\\s*\"([^\"]+)\"')",
    '    if ($idMatch.Success) { $result.instanceId = $idMatch.Groups[1].Value }',
    "    $authMatch = [regex]::Match($ping.body, '\"authUrl\"\\s*:\\s*\"([^\"]+)\"')",
    '    if ($authMatch.Success) { $result.authUrl = $authMatch.Groups[1].Value }',
    '    if (Test-GuiReady $result) {',
    "      $result.probeClass = 'up-dsh'",
    '      return $result',
    '    }',
    "    $result.probeClass = 'starting'",
    '    return $result',
    '  }',
    '  $root = Get-HttpProbe $url 2',
    '  if (-not $root.reachable -and -not $ping.reachable) {',
    "    $result.probeClass = 'port-no-response'",
    '    return $result',
    '  }',
    '  if ($root.reachable -and $root.status -eq 401 -and $root.body.Contains($fingerprint)) {',
    "    $result.probeClass = 'up-dsh'",
    '    $result.status = 401',
    '    $result.authRequired = $true',
    '    return $result',
    '  }',
    '  if ($root.reachable -and $root.status -ge 200 -and $root.status -lt 500) {',
    "    $result.probeClass = 'up-unknown'",
    '    $result.status = $root.status',
    '    return $result',
    '  }',
    "  $result.probeClass = 'port-no-response'",
    '  return $result',
    '}',
    '',
    'function Get-PortOwner {',
    "  $owner = @{ listening = $false; ownerPid = 0; ownerName = ''; ownerPath = '' }",
    '  $connection = $null',
    '  try {',
    '    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {',
    '      $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    }',
    '  } catch {}',
    '  if ($connection -ne $null) {',
    '    $owner.listening = $true',
    '    $owner.ownerPid = [int]$connection.OwningProcess',
    '  } else {',
    '    try {',
    "      $netstatLine = netstat.exe -ano | Select-String -Pattern (':' + $port + '\\s') | Select-Object -First 1",
    '      if ($netstatLine -ne $null) {',
    "        $parts = ($netstatLine.ToString().Trim() -split '\\s+')",
    '        $owner.listening = $true',
    '        $owner.ownerPid = [int]$parts[$parts.Length - 1]',
    '      }',
    '    } catch {}',
    '  }',
    '  if ($owner.ownerPid -gt 0) {',
    '    try {',
    '      $owningProcess = Get-Process -Id $owner.ownerPid -ErrorAction SilentlyContinue',
    '      if ($owningProcess -ne $null) {',
    '        $owner.ownerName = $owningProcess.ProcessName',
    '        try { $owner.ownerPath = $owningProcess.Path } catch {}',
    '      }',
    '    } catch {}',
    '  }',
    '  return $owner',
    '}',
    '',
    'function Get-ChildTail {',
    '  param([int]$Lines)',
    '  $collected = @()',
    '  foreach ($file in @($childErr, $childOut)) {',
    '    if (Test-Path -LiteralPath $file) {',
    '      try { $collected += @(Get-Content -LiteralPath $file -Tail $Lines -ErrorAction SilentlyContinue) } catch {}',
    '    }',
    '  }',
    '  if ($collected.Count -eq 0) { return "" }',
    '  $separator = [string][char]10',
    '  return (($collected | Select-Object -Last $Lines) -join $separator)',
    '}',
    '',
    'function Open-Browser {',
    '  param([string]$Target)',
    "  if ($Target -eq '') { $Target = $url }",
    '  $opened = $false',
    "  try { Start-Process -FilePath $Target -ErrorAction Stop; $opened = $true } catch { Write-Log ('Start-Process open failed: ' + $_) }",
    "  if (-not $opened) { try { Start-Process -FilePath 'explorer.exe' -ArgumentList $Target -ErrorAction Stop; $opened = $true } catch { Write-Log ('explorer open failed: ' + $_) } }",
    "  if (-not $opened) { try { cmd.exe /c start '' $Target 2>&1 | Out-Null; $opened = $true } catch { Write-Log ('cmd start open failed: ' + $_) } }",
    "  Write-Log ('open-browser result: opened=' + $opened + ' target=' + $Target)",
    '}',
    '',
    '# Resolve the URL to hand the browser: the bare origin answers 401 on a fresh',
    '# browser profile, so prefer a token URL (from /ping, or from the stdout of the',
    '# child this launcher started).',
    'function Resolve-OpenUrl {',
    '  param($Probe)',
    "  if ($Probe -ne $null -and $Probe.authUrl -ne '') { return $Probe.authUrl }",
    '  if (Test-Path -LiteralPath $childOut) {',
    '    try {',
    "      $found = Select-String -LiteralPath $childOut -Pattern '^dsh web:\\s*(\\S+)' | Select-Object -First 1",
    '      if ($found -ne $null) { return [string]$found.Matches[0].Groups[1].Value }',
    '    } catch {}',
    '  }',
    '  if (Test-Path -LiteralPath $authPath) {',
    '    try {',
    '      $remembered = (Get-Content -LiteralPath $authPath -Raw).Trim()',
    "      if ($remembered -ne '') { return $remembered }",
    '    } catch {}',
    '  }',
    '  return $url',
    '}',
    '',
    'function Show-Message {',
    '  param([string]$Text, [string]$Title)',
    '  try {',
    '    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop | Out-Null',
    '    [System.Windows.MessageBox]::Show($Text, $Title) | Out-Null',
    '  } catch { Write-Log ("message box failed: " + $_) }',
    '}',
    '',
  ].join('\n')
}

/** Classify a `dsh` command the way the launcher does (Application > ExternalScript). */
function renderDshCommandResolver(): string {
  return [
    '$commands = @(Get-Command $dshCommand -All -ErrorAction SilentlyContinue)',
    "$command = $commands | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -match '\\.(?:cmd|exe|bat|com)$' } | Select-Object -First 1",
    "if ($null -eq $command) { $command = $commands | Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1 }",
    "if ($null -eq $command) { $command = $commands | Where-Object { $_.CommandType -eq 'ExternalScript' } | Select-Object -First 1 }",
  ].join('\n')
}

/** Turn a resolved `$command` into the file path + argv used by Start-Process. */
function renderSpawnArguments(): string {
  return [
    "$arguments = if ($dshProfile -eq '') { @('web', '--no-open') } else { @('--profile', $dshProfile, '--no-open') }",
    '$filePath = $command.Source',
    "if ($command.CommandType -eq 'ExternalScript' -or $command.Source -match '\\.ps1$') {",
    "  $arguments = @('-NoProfile', '-File', $command.Source) + $arguments",
    "  $filePath = 'powershell.exe'",
    '}',
  ].join('\n')
}

/** Probe result plus timestamp, as the status files spell it. */
function renderProbeObject(indent: string): string {
  return [
    indent + 'probe = @{',
    indent + "  class = $probe.probeClass",
    indent + '  status = $probe.status',
    indent + '  authRequired = $probe.authRequired',
    indent + "  checkedAt = (Get-Date).ToUniversalTime().ToString('o')",
    indent + '}',
  ].join('\n')
}

/** Atomic UTF-8 (no BOM) JSON write, shared by both generated Windows scripts. */
function renderAtomicJsonWriter(indent: string): string {
  return [
    indent + '$json = $state | ConvertTo-Json -Depth 8',
    indent + "$temp = $statusPath + '.tmp'",
    indent + '[System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))',
    indent + 'Move-Item -Force -LiteralPath $temp -Destination $statusPath',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Windows launcher
// ---------------------------------------------------------------------------

/**
 * PowerShell launcher body: serialize concurrent invocations with a named
 * mutex, classify the port with the tiered probe, start `dsh web --no-open`
 * with captured output, poll to readiness, then open the default browser.
 * Every branch writes launcher-status.json so a failure is diagnosable from the
 * GUI without reading logs.
 */
function renderPowerShell(spec: LauncherSpec): string {
  return [
    '# DSH web launcher (generated by dsh-desktop_quick_launcher v0.2)',
    "$ErrorActionPreference = 'Continue'",
    `$dshCommand = ${psSingle(spec.dshCommand)}`,
    `$url = ${psSingle(spec.url)}`,
    `$port = ${spec.port}`,
    `$dshProfile = ${psSingle(spec.profile ?? '')}`,
    '$scriptDir = $PSScriptRoot',
    `$log = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.launcherLog)}`,
    `$statusPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.launcherStatus)}`,
    `$childOut = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childOut)}`,
    `$childErr = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childErr)}`,
    `$authPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.authUrl)}`,
    `$pingPath = ${psSingle(PLUGIN_ROUTE_PREFIX + '/ping')}`,
    `$pluginId = ${psSingle('dsh-desktop_quick_launcher')}`,
    `$fingerprint = ${psSingle('dsh web authentication required')}`,
    `$waitSeconds = ${DEFAULT_WAIT_SECONDS}`,
    '',
    'function Write-Log {',
    '  param([string]$Message)',
    "  try { Add-Content -Path $log -Value (('[dsh-launcher] ' + (Get-Date -Format 's') + ' | ' + $Message)) -Encoding UTF8 } catch {}",
    '}',
    '',
    'function Write-Status {',
    '  param([string]$Phase, [string]$Message, $Extra)',
    '  try {',
    '    $state = [ordered]@{',
    '      schema = 1',
    "      updatedAt = (Get-Date).ToUniversalTime().ToString('o')",
    '      phase = $Phase',
    '      message = $Message',
    '    }',
    '    if ($Extra -ne $null) {',
    '      foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }',
    '    }',
    renderAtomicJsonWriter('    '),
    '  } catch {',
    "    Write-Log ('status write failed: ' + $_)",
    '  }',
    '}',
    '',
    renderProbeFunctions(),
    'function Wait-ExistingInstance {',
    "  Write-Log 'another launcher holds the mutex -> waiting for the existing startup'",
    "  $mutexInfo = @{ acquired = $false; waitedForExisting = $true }",
    "  Write-Status -Phase 'mutex-held' -Message '另一个启动流程正在进行，已改为等待' -Extra @{ mutex = $mutexInfo }",
    '  $deadline = (Get-Date).AddSeconds($waitSeconds)',
    '  while ((Get-Date) -lt $deadline) {',
    '    Start-Sleep -Milliseconds 500',
    '    $probe = Get-Probe',
    "    if ($probe.probeClass -eq 'up-dsh') {",
    "      Write-Log 'existing startup became ready -> open browser'",
    '      Open-Browser (Resolve-OpenUrl $probe)',
    "      Write-Status -Phase 'ready' -Message '服务已就绪，已打开浏览器' -Extra @{ mutex = $mutexInfo; probe = @{ class = 'up-dsh'; status = $probe.status; authRequired = $probe.authRequired; checkedAt = (Get-Date).ToUniversalTime().ToString('o') } }",
    '      return 0',
    '    }',
    '  }',
    "  $message = '等待已有启动流程超时（' + $waitSeconds + ' 秒）'",
    '  Write-Log $message',
    "  Write-Status -Phase 'timeout-alive' -Message $message -Extra @{ mutex = $mutexInfo; hint = '查看 launcher.log 与 dsh-child 日志' }",
    "  Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '  return 1',
    '}',
    '',
    'function Invoke-Launch {',
    "  Write-Log 'launcher invoked'",
    '  $probe = Get-Probe',
    "  Write-Log ('probe: ' + $probe.probeClass + ' status=' + $probe.status)",
    "  if ($probe.probeClass -eq 'up-dsh') {",
    "    Write-Log 'service already running -> open browser'",
    '    Open-Browser (Resolve-OpenUrl $probe)',
    "    $hint = ''",
    "    if ($probe.authRequired) { $hint = '页面若要求认证，请打开 dsh web 控制台打印的带 token 的 URL' }",
    "    Write-Status -Phase 'up-dsh' -Message '服务已在运行，已打开浏览器' -Extra @{",
    renderProbeObject('      '),
    '      hint = $hint',
    '    }',
    '    return 0',
    '  }',
    "  if ($probe.probeClass -eq 'starting') {",
    "    Write-Log 'service is up but the Web UI is not ready yet -> wait, never spawn a second instance'",
    "    Write-Status -Phase 'starting' -Message '服务已启动，正在等待 Web 界面就绪'",
    '    $uiDeadline = (Get-Date).AddSeconds($waitSeconds)',
    '    while ((Get-Date) -lt $uiDeadline) {',
    '      Start-Sleep -Milliseconds 500',
    '      $probe = Get-Probe',
    "      if ($probe.probeClass -eq 'up-dsh') {",
    "        Write-Log 'web ui ready -> open browser'",
    '        Open-Browser (Resolve-OpenUrl $probe)',
    "        Write-Status -Phase 'ready' -Message 'Web 界面已就绪，已打开浏览器' -Extra @{",
    renderProbeObject('          '),
    '        }',
    '        return 0',
    '      }',
    '    }',
    "    $message = '服务已启动，但 ' + $waitSeconds + ' 秒内 Web 界面仍未就绪'",
    '    Write-Log $message',
    "    Write-Status -Phase 'timeout-alive' -Message $message -Extra @{ hint = '没有再启动第二个实例；稍后在浏览器里刷新页面即可' }",
    "    Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '    return 1',
    '  }',
    "  if ($probe.probeClass -eq 'up-unknown' -or $probe.probeClass -eq 'port-no-response') {",
    '    $owner = Get-PortOwner',
    "    $ownerText = if ($owner.ownerName -ne '') { $owner.ownerName + ' (pid ' + $owner.ownerPid + ')' } else { 'pid ' + $owner.ownerPid }",
    "    if ($probe.probeClass -eq 'up-unknown') {",
    "      $message = '端口 ' + $port + ' 已被 ' + $ownerText + ' 占用，它不是 DSH'",
    "      $hint = '请先结束该进程，或在插件配置里把 url 改成其他端口'",
    '    } else {',
    "      $message = '端口 ' + $port + ' 已被占用但无响应（疑似僵死实例）：' + $ownerText",
    "      $hint = '结束该进程后重试'",
    '    }',
    '    Write-Log $message',
    '    Write-Status -Phase $probe.probeClass -Message $message -Extra @{',
    renderProbeObject('      '),
    '      hint = $hint',
    '      port = $owner',
    '    }',
    "    Show-Message ($message + [char]10 + $hint + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '    return 1',
    '  }',
    '',
    renderDshCommandResolver(),
    '  if ($null -eq $command) {',
    "    $whereText = ''",
    "    try { $whereText = (where.exe $dshCommand 2>&1 | Out-String).Trim() } catch {}",
    "    $message = '找不到 dsh 命令：' + $dshCommand",
    "    $hint = '确认 dsh 已加入 PATH（nvm 用户的软链目录通常是 C:\\nvm4w\\nodejs）。where 输出：' + $whereText",
    '    Write-Log $message',
    "    Write-Status -Phase 'dsh-not-found' -Message $message -Extra @{ hint = $hint }",
    "    Show-Message ($message + [char]10 + $hint + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '    return 1',
    '  }',
    '',
    "  Write-Log ('found dsh: ' + $command.Source)",
    renderSpawnArguments(),
    "  Write-Status -Phase 'spawned' -Message ('正在启动：' + $command.Source)",
    '  $dshProcess = Start-Process -FilePath $filePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr',
    "  Write-Log ('spawned dsh, pid=' + $dshProcess.Id)",
    '  $deadline = (Get-Date).AddSeconds($waitSeconds)',
    '  while ((Get-Date) -lt $deadline) {',
    '    Start-Sleep -Milliseconds 500',
    '    $probe = Get-Probe',
    "    if ($probe.probeClass -eq 'up-dsh') {",
    "      Write-Log 'service ready -> open browser'",
    '      Open-Browser (Resolve-OpenUrl $probe)',
    "      $hint = ''",
    "      if ($probe.authRequired) { $hint = '页面若要求认证，请打开 dsh web 控制台打印的带 token 的 URL' }",
    "      Write-Status -Phase 'ready' -Message '服务已就绪，已打开浏览器' -Extra @{",
    renderProbeObject('        '),
    '        child = @{ pid = $dshProcess.Id; exitCode = $null; outLog = $childOut; errLog = $childErr }',
    '        hint = $hint',
    '      }',
    '      return 0',
    '    }',
    '    if ($dshProcess.HasExited) {',
    '      $tail = Get-ChildTail 15',
    "      $message = 'DSH 启动后退出（代码 ' + $dshProcess.ExitCode + '）'",
    "      $hint = '把 tail 里的报错贴出来即可定位'",
    '      Write-Log $message',
    "      Write-Status -Phase 'child-exit' -Message $message -Extra @{",
    renderProbeObject('        '),
    '        child = @{ pid = $dshProcess.Id; exitCode = $dshProcess.ExitCode; outLog = $childOut; errLog = $childErr; tail = $tail }',
    '        port = (Get-PortOwner)',
    '        hint = $hint',
    '      }',
    "      Show-Message ($message + [char]10 + $tail + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '      return 1',
    '    }',
    '  }',
    '',
    '  $tail = Get-ChildTail 15',
    '  if ($dshProcess.HasExited) {',
    "    $message = 'DSH 在 ' + $waitSeconds + ' 秒内未就绪且进程已退出（代码 ' + $dshProcess.ExitCode + '）'",
    "    $phase = 'timeout-dead'",
    '  } else {',
    "    $message = 'DSH 进程仍在运行，但 ' + $waitSeconds + ' 秒内未响应（疑似卡在插件加载）'",
    "    $phase = 'timeout-alive'",
    '  }',
    "  $hint = '可用 --patch 叠加最小配置逐个排查插件；tail 见下'",
    '  Write-Log $message',
    '  Write-Status -Phase $phase -Message $message -Extra @{',
    renderProbeObject('    '),
    '    child = @{ pid = $dshProcess.Id; exitCode = $dshProcess.ExitCode; outLog = $childOut; errLog = $childErr; tail = $tail }',
    '    port = (Get-PortOwner)',
    '    hint = $hint',
    '  }',
    "  Show-Message ($message + [char]10 + $tail + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '  return 1',
    '}',
    '',
    "$mutexName = 'Local\\DSH-Web-Launcher-' + $port",
    '$mutex = $null',
    '$ownsMutex = $false',
    'try {',
    '  $mutex = New-Object System.Threading.Mutex($false, $mutexName)',
    '  $ownsMutex = $mutex.WaitOne(0)',
    '} catch { $ownsMutex = $false }',
    '',
    '$exitCode = 1',
    'try {',
    '  if ($ownsMutex) { $exitCode = Invoke-Launch } else { $exitCode = Wait-ExistingInstance }',
    '} catch {',
    "  $message = '启动流程异常：' + $_",
    '  Write-Log $message',
    "  Write-Status -Phase 'error' -Message $message -Extra @{ hint = '查看 launcher.log 与 dsh-child 日志' }",
    "  Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
    '  $exitCode = 1',
    '} finally {',
    '  if ($ownsMutex -and $mutex -ne $null) { try { $mutex.ReleaseMutex() } catch {} }',
    '  if ($mutex -ne $null) { try { $mutex.Dispose() } catch {} }',
    '}',
    'exit $exitCode',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// restart helper
// ---------------------------------------------------------------------------

/**
 * PowerShell restart helper, generated per restart with every value baked in
 * (so the L2 `schtasks /tr` command line needs no argument quoting).
 *
 * Contract: the host hands over (writes `handoff`, spawns this helper, then
 * exits gracefully). The helper waits out the grace period, re-reads the status
 * file and aborts if the host cancelled (`aborted-busy`); otherwise it verifies
 * the old instance is gone — stopping it only as a fallback, and never with
 * `taskkill /T`, because the helper is a descendant of the old host and `/T`
 * would kill the helper itself — then starts the replacement and waits for a
 * `/ping` whose instanceId differs from the previous one.
 */
export function renderRestartHelper(spec: RestartSpec): string {
  return [
    '# DSH web restart helper (generated by dsh-desktop_quick_launcher v0.2)',
    "$ErrorActionPreference = 'Continue'",
    `$port = ${spec.port}`,
    `$url = ${psSingle(spec.url)}`,
    `$oldHostPid = ${spec.hostPid}`,
    `$graceMs = ${spec.graceMs}`,
    `$dshCommand = ${psSingle(spec.dshCommand)}`,
    `$dshProfile = ${psSingle(spec.profile ?? '')}`,
    `$instanceIdBefore = ${psSingle(spec.instanceIdBefore)}`,
    `$waitSeconds = ${spec.waitSeconds}`,
    `$dshHome = ${psSingle(spec.dshHome)}`,
    `$hostCwd = ${psSingle(spec.cwd)}`,
    '$scriptDir = $PSScriptRoot',
    '$selfPid = $PID',
    `$log = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.helperLog)}`,
    `$statusPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.restartStatus)}`,
    `$inflightPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.restartInflight)}`,
    `$childOut = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childOut)}`,
    `$childErr = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childErr)}`,
    `$authPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.authUrl)}`,
    `$pingPath = ${psSingle(PLUGIN_ROUTE_PREFIX + '/ping')}`,
    `$pluginId = ${psSingle('dsh-desktop_quick_launcher')}`,
    `$fingerprint = ${psSingle('dsh web authentication required')}`,
    '',
    'function Write-Log {',
    '  param([string]$Message)',
    "  try { Add-Content -Path $log -Value (('[dsh-restart] ' + (Get-Date -Format 's') + ' | ' + $Message)) -Encoding UTF8 } catch {}",
    '}',
    '',
    'function Read-State {',
    '  if (-not (Test-Path -LiteralPath $statusPath)) { return $null }',
    '  try { return (Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }',
    '}',
    '',
    'function Save-State {',
    '  param([string]$Phase, $Extra)',
    '  try {',
    '    $state = Read-State',
    '    if ($state -eq $null) { $state = New-Object System.Object }',
    '    $state | Add-Member -NotePropertyName schema -NotePropertyValue 1 -Force',
    "    $state | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force",
    '    $state | Add-Member -NotePropertyName phase -NotePropertyValue $Phase -Force',
    '    if ($Extra -ne $null) {',
    '      foreach ($key in $Extra.Keys) { $state | Add-Member -NotePropertyName $key -NotePropertyValue $Extra[$key] -Force }',
    '    }',
    renderAtomicJsonWriter('    '),
    '  } catch {',
    "    Write-Log ('state write failed: ' + $_)",
    '  }',
    '}',
    '',
    'function Clear-Inflight {',
    '  try { Remove-Item -LiteralPath $inflightPath -Force -ErrorAction SilentlyContinue } catch {}',
    '}',
    '',
    'function Get-AuthUrl {',
    '  if (-not (Test-Path -LiteralPath $childOut)) { return "" }',
    '  try {',
    "    $found = Select-String -LiteralPath $childOut -Pattern '^dsh web:\\s*(\\S+)' | Select-Object -First 1",
    '    if ($found -ne $null) { return [string]$found.Matches[0].Groups[1].Value }',
    '  } catch {}',
    '  return ""',
    '}',
    '',
    renderProbeFunctions(),
    "Write-Log ('helper started pid=' + $selfPid + ' oldHostPid=' + $oldHostPid + ' port=' + $port)",
    '$state = Read-State',
    "if ($state -ne $null -and $state.phase -eq 'aborted-busy') { Write-Log 'host already aborted the restart'; Clear-Inflight; exit 0 }",
    "Save-State -Phase 'verifying-old' -Extra @{}",
    'Start-Sleep -Milliseconds ($graceMs + 2000)',
    '$state = Read-State',
    "if ($state -ne $null -and $state.phase -eq 'aborted-busy') { Write-Log 'host aborted the restart during the grace period'; Clear-Inflight; exit 0 }",
    '',
    '$waited = 0',
    'while ($waited -lt 30000 -and (Test-TcpPort $port)) { Start-Sleep -Milliseconds 500; $waited += 500 }',
    'if (Test-TcpPort $port) {',
    "  Write-Log 'old instance still listening -> fallback kill (deliberately without /T)'",
    "  Save-State -Phase 'killing' -Extra @{}",
    '  $killed = @()',
    '  try {',
    "    $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $oldHostPid) -ErrorAction SilentlyContinue)",
    '    foreach ($child in $children) {',
    '      if ([int]$child.ProcessId -eq $selfPid) { continue }',
    '      taskkill.exe /PID $child.ProcessId /F 2>&1 | Out-Null',
    "      $killed += @{ pid = [int]$child.ProcessId; name = [string]$child.Name; reason = 'child-of-old-host' }",
    '    }',
    "  } catch { Write-Log ('child enumeration failed: ' + $_) }",
    '  taskkill.exe /PID $oldHostPid /F 2>&1 | Out-Null',
    "  $killed += @{ pid = $oldHostPid; name = ''; reason = 'graceful-exit-timeout' }",
    "  Save-State -Phase 'killing' -Extra @{ killed = $killed }",
    '  $releaseWait = 0',
    '  while ($releaseWait -lt 15000 -and (Test-TcpPort $port)) { Start-Sleep -Milliseconds 500; $releaseWait += 500 }',
    '}',
    'if (Test-TcpPort $port) {',
    "  $message = '端口 ' + $port + ' 仍被占用，未能停止旧实例'",
    '  Write-Log $message',
    "  Save-State -Phase 'failed' -Extra @{ error = $message; hint = '请手动结束占用该端口的进程后重试' }",
    '  Clear-Inflight',
    '  exit 1',
    '}',
    '',
    "Save-State -Phase 'spawning' -Extra @{}",
    renderDshCommandResolver(),
    'if ($null -eq $command) {',
    "  Save-State -Phase 'failed' -Extra @{ error = ('找不到 dsh 命令：' + $dshCommand); hint = '确认 dsh 已加入 PATH 后重试' }",
    '  Clear-Inflight',
    '  exit 1',
    '}',
    renderSpawnArguments(),
    '$spawnStart = Get-Date',
    '# A scheduled task runs in %SystemRoot%\\System32 with no DSH_HOME set;',
    '# restore both before starting the replacement.',
    "try { Set-Location -LiteralPath $hostCwd } catch { Write-Log ('Set-Location failed: ' + $_) }",
    '$env:DSH_HOME = $dshHome',
    '$workingDir = $hostCwd',
    'if (-not (Test-Path -LiteralPath $workingDir)) { $workingDir = $scriptDir }',
    'try {',
    '  $newProcess = Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $workingDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr',
    '} catch {',
    "  Save-State -Phase 'failed' -Extra @{ error = ('启动新实例失败：' + $_); hint = '见 restart-helper.log' }",
    '  Clear-Inflight',
    '  exit 1',
    '}',
    "Write-Log ('spawned new dsh, pid=' + $newProcess.Id)",
    "Save-State -Phase 'spawning' -Extra @{ spawned = @{ pid = $newProcess.Id; command = $filePath; args = $arguments } }",
    '',
    '$deadline = (Get-Date).AddSeconds($waitSeconds)',
    '$ready = $false',
    '$probe = $null',
    'while ((Get-Date) -lt $deadline) {',
    '  Start-Sleep -Milliseconds 500',
    '  $probe = Get-Probe',
    "  if ($probe.probeClass -eq 'up-dsh' -and $probe.instanceId -ne '' -and $probe.instanceId -ne $instanceIdBefore) { $ready = $true; break }",
    '  if ($newProcess -ne $null -and $newProcess.HasExited) { break }',
    '}',
    '$authUrl = Get-AuthUrl',
    '$tail = Get-ChildTail 15',
    'if ($ready) {',
    "  Write-Log ('new instance ready: ' + $probe.instanceId)",
    "  Save-State -Phase 'ready' -Extra @{",
    '    ready = @{ instanceId = $probe.instanceId; pid = $newProcess.Id; waitedMs = [int]((Get-Date) - $spawnStart).TotalMilliseconds }',
    '    authUrl = $authUrl',
    '    childTail = $tail',
    "    error = ''",
    "    hint = ''",
    '  }',
    '  Clear-Inflight',
    '  exit 0',
    '}',
    'if ($newProcess -ne $null -and $newProcess.HasExited) {',
    "  $message = '新实例启动后退出（代码 ' + $newProcess.ExitCode + '）'",
    '  Write-Log $message',
    "  Save-State -Phase 'failed' -Extra @{ error = $message; childTail = $tail; hint = '见 restart-helper.log 与 dsh-child.err.log' }",
    '  Clear-Inflight',
    '  exit 1',
    '}',
    "$message = '新实例在 ' + $waitSeconds + ' 秒内未就绪'",
    'Write-Log $message',
    "Save-State -Phase 'timeout' -Extra @{ error = $message; childTail = $tail; hint = '见 restart-helper.log 与 dsh-child.err.log' }",
    'Clear-Inflight',
    'exit 1',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// POSIX launcher (unchanged from v0.1; not verified on real hardware)
// ---------------------------------------------------------------------------

/** POSIX launcher (macOS .command / Linux .sh) with the platform open command. */
function renderPosix(platform: 'darwin' | 'linux', spec: LauncherSpec): string {
  const open = platform === 'darwin' ? 'open' : 'xdg-open'
  const alert = platform === 'darwin'
    ? "osascript -e 'display dialog \"dsh command not found: '\"$DASH\"'\" with title \"DSH Quick Launcher\" with icon caution' 2>/dev/null || echo \"dsh command not found: $DASH\" >&2"
    : 'zenity --error --title="DSH Quick Launcher" --text="dsh command not found: $DASH" 2>/dev/null || echo "dsh command not found: $DASH" >&2'
  return [
    '#!/bin/bash',
    '# DSH web launcher (generated by dsh-desktop_quick_launcher)',
    `DASH=${shSingle(spec.dshCommand)}`,
    `URL=${shSingle(spec.url)}`,
    `PROFILE=${shSingle(spec.profile ?? '')}`,
    '',
    'probe() {',
    '  curl -fsS --max-time 2 "$URL" >/dev/null 2>&1',
    '}',
    '',
    'if probe; then',
    `  ${open} "$URL"`,
    '  exit 0',
    'fi',
    '',
    'if ! command -v "$DASH" >/dev/null 2>&1; then',
    `  ${alert}`,
    '  exit 1',
    'fi',
    '',
    'if [ -n "$PROFILE" ]; then',
    '  "$DASH" --profile "$PROFILE" --no-open >/dev/null 2>&1 &',
    'else',
    '  "$DASH" web --no-open >/dev/null 2>&1 &',
    'fi',
    'DASH_PID=$!',
    '',
    'for i in $(seq 1 60); do',
    '  if probe; then',
    `    ${open} "$URL"`,
    '    exit 0',
    '  fi',
    '  if ! kill -0 "$DASH_PID" 2>/dev/null; then',
    '    echo "dsh process exited unexpectedly" >&2',
    '    exit 1',
    '  fi',
    '  sleep 2',
    'done',
    '',
    'echo "dsh web did not start within 120 seconds: $URL" >&2',
    'exit 1',
    '',
  ].join('\n')
}

/** Render the launcher script for one platform. */
export function renderLauncherScript(platform: LauncherPlatform, spec: LauncherSpec): string {
  switch (platform) {
    case 'win32': return renderPowerShell(spec)
    case 'darwin':
    case 'linux': return renderPosix(platform, spec)
  }
}

/** Render the Linux desktop entry (macOS uses the launcher itself as the desktop file). */
export function renderDesktopEntry(launcherPath: string, iconPath?: string): string {
  const iconLine = iconPath === undefined ? 'Icon=utilities-terminal' : `Icon=${iconPath}`
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DSH Web',
    'Comment=Launch DeepSeek Harness Web GUI',
    `Exec="${launcherPath}"`,
    iconLine,
    'Terminal=true',
    'Categories=Development;',
    '',
  ].join('\n')
}

/**
 * Render the Windows shortcut installer: a PowerShell script that creates the
 * Desktop .lnk pointing at the launcher script, executed hidden by the host.
 */
export function renderShortcutInstaller(opts: {
  /** Absolute path of launcher.ps1. */
  launcherPath: string
  /** Absolute path of the .lnk to create. */
  desktopPath: string
  /** Working directory of the shortcut. */
  workingDirectory?: string
  /** Icon the shortcut shows (an .ico/.png path, or a shell-exe icon spec). */
  iconLocation: string
}): string {
  const { launcherPath, desktopPath, workingDirectory, iconLocation } = opts
  const targetWorkingDir = workingDirectory ?? ''
  return [
    '# DSH desktop shortcut installer (generated by dsh-desktop_quick_launcher)',
    "$ErrorActionPreference = 'Stop'",
    '$ws = New-Object -ComObject WScript.Shell',
    `$shortcut = $ws.CreateShortcut(${psSingle(desktopPath)})`,
    `$shortcut.TargetPath = ${psSingle('powershell.exe')}`,
    `$shortcut.Arguments = ${psSingle(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${launcherPath}`)}`,
    `$shortcut.WorkingDirectory = ${psSingle(targetWorkingDir)}`,
    `$shortcut.IconLocation = ${psSingle(iconLocation)}`,
    `$shortcut.Description = ${psSingle('Launch DeepSeek Harness Web GUI')}`,
    '$shortcut.Save()',
    '',
  ].join('\n')
}
