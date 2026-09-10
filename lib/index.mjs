import { a as stripBom, i as phaseSeverity, n as isLauncherFailure, o as tailLines, r as parseStatusFile, t as formatDuration } from "./status-BtM5rj-h.mjs";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import z from "schemastery";
/** Default GUI URL. */
const DEFAULT_URL = "http://127.0.0.1:3080";
/** Default listen port. */
const DEFAULT_PORT = 3080;
/** Default grace period between the 202 acknowledgement and the host's exit. */
const DEFAULT_GRACE_MS = 1500;
/** Same-origin route prefix; the single source of truth for both halves. */
const PLUGIN_ROUTE_PREFIX = "/api/dsh-desktop_quick_launcher";
/** File names written next to the launcher script under <dsh-home>/. */
const LAUNCHER_FILES = {
	launcherScript: "launcher.ps1",
	restartHelper: "restart-helper.ps1",
	shortcutInstaller: "install-shortcut.ps1",
	launcherLog: "launcher.log",
	helperLog: "restart-helper.log",
	childOut: "dsh-child.out.log",
	childErr: "dsh-child.err.log",
	launcherStatus: "launcher-status.json",
	restartStatus: "restart-status.json",
	restartInflight: "restart-inflight.json",
	authUrl: "auth-url.txt",
	icon: "dsh.ico",
	iconPng: "dsh.png"
};
/** Port implied by a URL, falling back to the plugin default. */
function portFromUrl(url, fallback = DEFAULT_PORT) {
	try {
		const parsed = new URL(url);
		if (parsed.port !== "") return Number(parsed.port);
		if (parsed.protocol === "https:") return 443;
		if (parsed.protocol === "http:") return 80;
	} catch {}
	return fallback;
}
/** Resolve defaults from a partial config; empty profile means "no --profile flag". */
function resolveLauncherSpec(config) {
	const url = config.url ?? "http://127.0.0.1:3080";
	return {
		dshCommand: config.dshCommand ?? "dsh",
		url,
		port: config.port ?? portFromUrl(url),
		...config.profile === void 0 || config.profile === "" ? {} : { profile: config.profile },
		...config.iconPath === void 0 || config.iconPath === "" ? {} : { iconPath: config.iconPath }
	};
}
/** File name of the launcher script under <dsh-home>/desktop-quick-launcher/. */
function scriptFileName(platform) {
	switch (platform) {
		case "win32": return LAUNCHER_FILES.launcherScript;
		case "darwin": return "launcher.command";
		case "linux": return "launcher.sh";
	}
}
/** File name of the icon placed on the Desktop. */
function desktopFileName(platform) {
	switch (platform) {
		case "win32": return "DSH-Web.lnk";
		case "darwin": return "DeepSeek-Harness.command";
		case "linux": return "deepseek-harness.desktop";
	}
}
/** Arguments used to run a generated PowerShell script hidden. */
const HIDDEN_POWERSHELL_ARGS = [
	"-NoProfile",
	"-ExecutionPolicy",
	"Bypass",
	"-WindowStyle",
	"Hidden"
];
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
function renderScheduledTaskCommand(helperPath) {
	return `powershell.exe ${[
		...HIDDEN_POWERSHELL_ARGS,
		"-File",
		helperPath
	].map((part) => part.includes(" ") ? `"${part}"` : part).join(" ")}`;
}
/** Single-quote a value for PowerShell (embedded quotes are doubled). */
function psSingle(value) {
	return `'${value.replaceAll("'", "''")}'`;
}
/** Single-quote a value for POSIX sh (embedded quotes are escaped). */
function shSingle(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
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
function renderProbeFunctions() {
	return [
		"function Test-TcpPort {",
		"  param([int]$ProbePort)",
		"  $client = $null",
		"  try {",
		"    $client = New-Object System.Net.Sockets.TcpClient",
		"    $async = $client.BeginConnect('127.0.0.1', $ProbePort, $null, $null)",
		"    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }",
		"    $client.EndConnect($async)",
		"    return $true",
		"  } catch {",
		"    return $false",
		"  } finally {",
		"    if ($client -ne $null) { try { $client.Close() } catch {} }",
		"  }",
		"}",
		"",
		"function Get-HttpProbe {",
		"  param([string]$Uri, [int]$TimeoutSec)",
		"  $probe = @{ reachable = $true; status = 0; body = '' }",
		"  try {",
		"    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec $TimeoutSec",
		"    $probe.status = [int]$response.StatusCode",
		"    $probe.body = [string]$response.Content",
		"  } catch {",
		"    $webResponse = $_.Exception.Response",
		"    if ($webResponse -ne $null -and $webResponse.StatusCode -ne $null) {",
		"      $probe.status = [int]$webResponse.StatusCode",
		"      try {",
		"        $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())",
		"        $probe.body = $reader.ReadToEnd()",
		"        $reader.Close()",
		"      } catch {}",
		"    } else {",
		"      $probe.reachable = $false",
		"    }",
		"  }",
		"  return $probe",
		"}",
		"",
		"function Test-GuiReady {",
		"  param($Probe)",
		"  # A 200 from /ping only proves this plugin route is live. Until the SPA",
		"  # fallback registers, the server answers 404 for everything unclaimed, so a",
		"  # browser opened too early shows \"HTTP ERROR 404\" until a manual refresh.",
		"  # Require the real page (or the token exchange) before calling it ready.",
		"  if ($Probe -ne $null -and $Probe.authUrl -ne '') {",
		"    $token = Get-HttpProbe $Probe.authUrl 3",
		"    if ($token.status -ge 200 -and $token.status -lt 400) { return $true }",
		"  }",
		"  $root = Get-HttpProbe $url 3",
		"  if ($root.status -eq 401 -and $root.body.Contains($fingerprint)) { return $true }",
		"  if ($root.status -ge 200 -and $root.status -lt 400) { return $true }",
		"  return $false",
		"}",
		"",
		"function Get-Probe {",
		"  $result = @{ probeClass = 'down'; status = 0; instanceId = ''; authRequired = $false; authUrl = '' }",
		"  if (-not (Test-TcpPort $port)) { return $result }",
		"  $pingUri = $url.TrimEnd('/') + $pingPath",
		"  $ping = Get-HttpProbe $pingUri 2",
		"  if ($ping.reachable -and $ping.status -eq 200 -and $ping.body.Contains($pluginId)) {",
		"    $result.status = 200",
		"    $idMatch = [regex]::Match($ping.body, '\"instanceId\"\\s*:\\s*\"([^\"]+)\"')",
		"    if ($idMatch.Success) { $result.instanceId = $idMatch.Groups[1].Value }",
		"    $authMatch = [regex]::Match($ping.body, '\"authUrl\"\\s*:\\s*\"([^\"]+)\"')",
		"    if ($authMatch.Success) { $result.authUrl = $authMatch.Groups[1].Value }",
		"    if (Test-GuiReady $result) {",
		"      $result.probeClass = 'up-dsh'",
		"      return $result",
		"    }",
		"    $result.probeClass = 'starting'",
		"    return $result",
		"  }",
		"  $root = Get-HttpProbe $url 2",
		"  if (-not $root.reachable -and -not $ping.reachable) {",
		"    $result.probeClass = 'port-no-response'",
		"    return $result",
		"  }",
		"  if ($root.reachable -and $root.status -eq 401 -and $root.body.Contains($fingerprint)) {",
		"    $result.probeClass = 'up-dsh'",
		"    $result.status = 401",
		"    $result.authRequired = $true",
		"    return $result",
		"  }",
		"  if ($root.reachable -and $root.status -ge 200 -and $root.status -lt 500) {",
		"    $result.probeClass = 'up-unknown'",
		"    $result.status = $root.status",
		"    return $result",
		"  }",
		"  $result.probeClass = 'port-no-response'",
		"  return $result",
		"}",
		"",
		"function Get-PortOwner {",
		"  $owner = @{ listening = $false; ownerPid = 0; ownerName = ''; ownerPath = '' }",
		"  $connection = $null",
		"  try {",
		"    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {",
		"      $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1",
		"    }",
		"  } catch {}",
		"  if ($connection -ne $null) {",
		"    $owner.listening = $true",
		"    $owner.ownerPid = [int]$connection.OwningProcess",
		"  } else {",
		"    try {",
		"      $netstatLine = netstat.exe -ano | Select-String -Pattern (':' + $port + '\\s') | Select-Object -First 1",
		"      if ($netstatLine -ne $null) {",
		"        $parts = ($netstatLine.ToString().Trim() -split '\\s+')",
		"        $owner.listening = $true",
		"        $owner.ownerPid = [int]$parts[$parts.Length - 1]",
		"      }",
		"    } catch {}",
		"  }",
		"  if ($owner.ownerPid -gt 0) {",
		"    try {",
		"      $owningProcess = Get-Process -Id $owner.ownerPid -ErrorAction SilentlyContinue",
		"      if ($owningProcess -ne $null) {",
		"        $owner.ownerName = $owningProcess.ProcessName",
		"        try { $owner.ownerPath = $owningProcess.Path } catch {}",
		"      }",
		"    } catch {}",
		"  }",
		"  return $owner",
		"}",
		"",
		"function Get-ChildTail {",
		"  param([int]$Lines)",
		"  $collected = @()",
		"  foreach ($file in @($childErr, $childOut)) {",
		"    if (Test-Path -LiteralPath $file) {",
		"      try { $collected += @(Get-Content -LiteralPath $file -Tail $Lines -ErrorAction SilentlyContinue) } catch {}",
		"    }",
		"  }",
		"  if ($collected.Count -eq 0) { return \"\" }",
		"  $separator = [string][char]10",
		"  return (($collected | Select-Object -Last $Lines) -join $separator)",
		"}",
		"",
		"function Open-Browser {",
		"  param([string]$Target)",
		"  if ($Target -eq '') { $Target = $url }",
		"  $opened = $false",
		"  try { Start-Process -FilePath $Target -ErrorAction Stop; $opened = $true } catch { Write-Log ('Start-Process open failed: ' + $_) }",
		"  if (-not $opened) { try { Start-Process -FilePath 'explorer.exe' -ArgumentList $Target -ErrorAction Stop; $opened = $true } catch { Write-Log ('explorer open failed: ' + $_) } }",
		"  if (-not $opened) { try { cmd.exe /c start '' $Target 2>&1 | Out-Null; $opened = $true } catch { Write-Log ('cmd start open failed: ' + $_) } }",
		"  Write-Log ('open-browser result: opened=' + $opened + ' target=' + $Target)",
		"}",
		"",
		"# Resolve the URL to hand the browser: the bare origin answers 401 on a fresh",
		"# browser profile, so prefer a token URL (from /ping, or from the stdout of the",
		"# child this launcher started).",
		"function Resolve-OpenUrl {",
		"  param($Probe)",
		"  if ($Probe -ne $null -and $Probe.authUrl -ne '') { return $Probe.authUrl }",
		"  if (Test-Path -LiteralPath $childOut) {",
		"    try {",
		"      $found = Select-String -LiteralPath $childOut -Pattern '^dsh web:\\s*(\\S+)' | Select-Object -First 1",
		"      if ($found -ne $null) { return [string]$found.Matches[0].Groups[1].Value }",
		"    } catch {}",
		"  }",
		"  if (Test-Path -LiteralPath $authPath) {",
		"    try {",
		"      $remembered = (Get-Content -LiteralPath $authPath -Raw).Trim()",
		"      if ($remembered -ne '') { return $remembered }",
		"    } catch {}",
		"  }",
		"  return $url",
		"}",
		"",
		"function Show-Message {",
		"  param([string]$Text, [string]$Title)",
		"  try {",
		"    Add-Type -AssemblyName PresentationFramework -ErrorAction Stop | Out-Null",
		"    [System.Windows.MessageBox]::Show($Text, $Title) | Out-Null",
		"  } catch { Write-Log (\"message box failed: \" + $_) }",
		"}",
		""
	].join("\n");
}
/** Classify a `dsh` command the way the launcher does (Application > ExternalScript). */
function renderDshCommandResolver() {
	return [
		"$commands = @(Get-Command $dshCommand -All -ErrorAction SilentlyContinue)",
		"$command = $commands | Where-Object { $_.CommandType -eq 'Application' -and $_.Source -match '\\.(?:cmd|exe|bat|com)$' } | Select-Object -First 1",
		"if ($null -eq $command) { $command = $commands | Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1 }",
		"if ($null -eq $command) { $command = $commands | Where-Object { $_.CommandType -eq 'ExternalScript' } | Select-Object -First 1 }"
	].join("\n");
}
/** Turn a resolved `$command` into the file path + argv used by Start-Process. */
function renderSpawnArguments() {
	return [
		"$arguments = if ($dshProfile -eq '') { @('web', '--no-open') } else { @('--profile', $dshProfile, '--no-open') }",
		"$filePath = $command.Source",
		"if ($command.CommandType -eq 'ExternalScript' -or $command.Source -match '\\.ps1$') {",
		"  $arguments = @('-NoProfile', '-File', $command.Source) + $arguments",
		"  $filePath = 'powershell.exe'",
		"}"
	].join("\n");
}
/** Probe result plus timestamp, as the status files spell it. */
function renderProbeObject(indent) {
	return [
		indent + "probe = @{",
		indent + "  class = $probe.probeClass",
		indent + "  status = $probe.status",
		indent + "  authRequired = $probe.authRequired",
		indent + "  checkedAt = (Get-Date).ToUniversalTime().ToString('o')",
		indent + "}"
	].join("\n");
}
/** Atomic UTF-8 (no BOM) JSON write, shared by both generated Windows scripts. */
function renderAtomicJsonWriter(indent) {
	return [
		indent + "$json = $state | ConvertTo-Json -Depth 8",
		indent + "$temp = $statusPath + '.tmp'",
		indent + "[System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))",
		indent + "Move-Item -Force -LiteralPath $temp -Destination $statusPath"
	].join("\n");
}
/**
* PowerShell launcher body: serialize concurrent invocations with a named
* mutex, classify the port with the tiered probe, start `dsh web --no-open`
* with captured output, poll to readiness, then open the default browser.
* Every branch writes launcher-status.json so a failure is diagnosable from the
* GUI without reading logs.
*/
function renderPowerShell(spec) {
	return [
		"# DSH web launcher (generated by dsh-desktop_quick_launcher v0.2)",
		"$ErrorActionPreference = 'Continue'",
		`$dshCommand = ${psSingle(spec.dshCommand)}`,
		`$url = ${psSingle(spec.url)}`,
		`$port = ${spec.port}`,
		`$dshProfile = ${psSingle(spec.profile ?? "")}`,
		"$scriptDir = $PSScriptRoot",
		`$log = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.launcherLog)}`,
		`$statusPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.launcherStatus)}`,
		`$childOut = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childOut)}`,
		`$childErr = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childErr)}`,
		`$authPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.authUrl)}`,
		`$pingPath = ${psSingle(PLUGIN_ROUTE_PREFIX + "/ping")}`,
		`$pluginId = ${psSingle("dsh-desktop_quick_launcher")}`,
		`$fingerprint = ${psSingle("dsh web authentication required")}`,
		`$waitSeconds = 150`,
		"",
		"function Write-Log {",
		"  param([string]$Message)",
		"  try { Add-Content -Path $log -Value (('[dsh-launcher] ' + (Get-Date -Format 's') + ' | ' + $Message)) -Encoding UTF8 } catch {}",
		"}",
		"",
		"function Write-Status {",
		"  param([string]$Phase, [string]$Message, $Extra)",
		"  try {",
		"    $state = [ordered]@{",
		"      schema = 1",
		"      updatedAt = (Get-Date).ToUniversalTime().ToString('o')",
		"      phase = $Phase",
		"      message = $Message",
		"    }",
		"    if ($Extra -ne $null) {",
		"      foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }",
		"    }",
		renderAtomicJsonWriter("    "),
		"  } catch {",
		"    Write-Log ('status write failed: ' + $_)",
		"  }",
		"}",
		"",
		renderProbeFunctions(),
		"function Wait-ExistingInstance {",
		"  Write-Log 'another launcher holds the mutex -> waiting for the existing startup'",
		"  $mutexInfo = @{ acquired = $false; waitedForExisting = $true }",
		"  Write-Status -Phase 'mutex-held' -Message '另一个启动流程正在进行，已改为等待' -Extra @{ mutex = $mutexInfo }",
		"  $deadline = (Get-Date).AddSeconds($waitSeconds)",
		"  while ((Get-Date) -lt $deadline) {",
		"    Start-Sleep -Milliseconds 500",
		"    $probe = Get-Probe",
		"    if ($probe.probeClass -eq 'up-dsh') {",
		"      Write-Log 'existing startup became ready -> open browser'",
		"      Open-Browser (Resolve-OpenUrl $probe)",
		"      Write-Status -Phase 'ready' -Message '服务已就绪，已打开浏览器' -Extra @{ mutex = $mutexInfo; probe = @{ class = 'up-dsh'; status = $probe.status; authRequired = $probe.authRequired; checkedAt = (Get-Date).ToUniversalTime().ToString('o') } }",
		"      return 0",
		"    }",
		"  }",
		"  $message = '等待已有启动流程超时（' + $waitSeconds + ' 秒）'",
		"  Write-Log $message",
		"  Write-Status -Phase 'timeout-alive' -Message $message -Extra @{ mutex = $mutexInfo; hint = '查看 launcher.log 与 dsh-child 日志' }",
		"  Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"  return 1",
		"}",
		"",
		"function Invoke-Launch {",
		"  Write-Log 'launcher invoked'",
		"  $probe = Get-Probe",
		"  Write-Log ('probe: ' + $probe.probeClass + ' status=' + $probe.status)",
		"  if ($probe.probeClass -eq 'up-dsh') {",
		"    Write-Log 'service already running -> open browser'",
		"    Open-Browser (Resolve-OpenUrl $probe)",
		"    $hint = ''",
		"    if ($probe.authRequired) { $hint = '页面若要求认证，请打开 dsh web 控制台打印的带 token 的 URL' }",
		"    Write-Status -Phase 'up-dsh' -Message '服务已在运行，已打开浏览器' -Extra @{",
		renderProbeObject("      "),
		"      hint = $hint",
		"    }",
		"    return 0",
		"  }",
		"  if ($probe.probeClass -eq 'starting') {",
		"    Write-Log 'service is up but the Web UI is not ready yet -> wait, never spawn a second instance'",
		"    Write-Status -Phase 'starting' -Message '服务已启动，正在等待 Web 界面就绪'",
		"    $uiDeadline = (Get-Date).AddSeconds($waitSeconds)",
		"    while ((Get-Date) -lt $uiDeadline) {",
		"      Start-Sleep -Milliseconds 500",
		"      $probe = Get-Probe",
		"      if ($probe.probeClass -eq 'up-dsh') {",
		"        Write-Log 'web ui ready -> open browser'",
		"        Open-Browser (Resolve-OpenUrl $probe)",
		"        Write-Status -Phase 'ready' -Message 'Web 界面已就绪，已打开浏览器' -Extra @{",
		renderProbeObject("          "),
		"        }",
		"        return 0",
		"      }",
		"    }",
		"    $message = '服务已启动，但 ' + $waitSeconds + ' 秒内 Web 界面仍未就绪'",
		"    Write-Log $message",
		"    Write-Status -Phase 'timeout-alive' -Message $message -Extra @{ hint = '没有再启动第二个实例；稍后在浏览器里刷新页面即可' }",
		"    Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"    return 1",
		"  }",
		"  if ($probe.probeClass -eq 'up-unknown' -or $probe.probeClass -eq 'port-no-response') {",
		"    $owner = Get-PortOwner",
		"    $ownerText = if ($owner.ownerName -ne '') { $owner.ownerName + ' (pid ' + $owner.ownerPid + ')' } else { 'pid ' + $owner.ownerPid }",
		"    if ($probe.probeClass -eq 'up-unknown') {",
		"      $message = '端口 ' + $port + ' 已被 ' + $ownerText + ' 占用，它不是 DSH'",
		"      $hint = '请先结束该进程，或在插件配置里把 url 改成其他端口'",
		"    } else {",
		"      $message = '端口 ' + $port + ' 已被占用但无响应（疑似僵死实例）：' + $ownerText",
		"      $hint = '结束该进程后重试'",
		"    }",
		"    Write-Log $message",
		"    Write-Status -Phase $probe.probeClass -Message $message -Extra @{",
		renderProbeObject("      "),
		"      hint = $hint",
		"      port = $owner",
		"    }",
		"    Show-Message ($message + [char]10 + $hint + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"    return 1",
		"  }",
		"",
		renderDshCommandResolver(),
		"  if ($null -eq $command) {",
		"    $whereText = ''",
		"    try { $whereText = (where.exe $dshCommand 2>&1 | Out-String).Trim() } catch {}",
		"    $message = '找不到 dsh 命令：' + $dshCommand",
		"    $hint = '确认 dsh 已加入 PATH（nvm 用户的软链目录通常是 C:\\nvm4w\\nodejs）。where 输出：' + $whereText",
		"    Write-Log $message",
		"    Write-Status -Phase 'dsh-not-found' -Message $message -Extra @{ hint = $hint }",
		"    Show-Message ($message + [char]10 + $hint + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"    return 1",
		"  }",
		"",
		"  Write-Log ('found dsh: ' + $command.Source)",
		renderSpawnArguments(),
		"  Write-Status -Phase 'spawned' -Message ('正在启动：' + $command.Source)",
		"  $dshProcess = Start-Process -FilePath $filePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr",
		"  Write-Log ('spawned dsh, pid=' + $dshProcess.Id)",
		"  $deadline = (Get-Date).AddSeconds($waitSeconds)",
		"  while ((Get-Date) -lt $deadline) {",
		"    Start-Sleep -Milliseconds 500",
		"    $probe = Get-Probe",
		"    if ($probe.probeClass -eq 'up-dsh') {",
		"      Write-Log 'service ready -> open browser'",
		"      Open-Browser (Resolve-OpenUrl $probe)",
		"      $hint = ''",
		"      if ($probe.authRequired) { $hint = '页面若要求认证，请打开 dsh web 控制台打印的带 token 的 URL' }",
		"      Write-Status -Phase 'ready' -Message '服务已就绪，已打开浏览器' -Extra @{",
		renderProbeObject("        "),
		"        child = @{ pid = $dshProcess.Id; exitCode = $null; outLog = $childOut; errLog = $childErr }",
		"        hint = $hint",
		"      }",
		"      return 0",
		"    }",
		"    if ($dshProcess.HasExited) {",
		"      $tail = Get-ChildTail 15",
		"      $message = 'DSH 启动后退出（代码 ' + $dshProcess.ExitCode + '）'",
		"      $hint = '把 tail 里的报错贴出来即可定位'",
		"      Write-Log $message",
		"      Write-Status -Phase 'child-exit' -Message $message -Extra @{",
		renderProbeObject("        "),
		"        child = @{ pid = $dshProcess.Id; exitCode = $dshProcess.ExitCode; outLog = $childOut; errLog = $childErr; tail = $tail }",
		"        port = (Get-PortOwner)",
		"        hint = $hint",
		"      }",
		"      Show-Message ($message + [char]10 + $tail + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"      return 1",
		"    }",
		"  }",
		"",
		"  $tail = Get-ChildTail 15",
		"  if ($dshProcess.HasExited) {",
		"    $message = 'DSH 在 ' + $waitSeconds + ' 秒内未就绪且进程已退出（代码 ' + $dshProcess.ExitCode + '）'",
		"    $phase = 'timeout-dead'",
		"  } else {",
		"    $message = 'DSH 进程仍在运行，但 ' + $waitSeconds + ' 秒内未响应（疑似卡在插件加载）'",
		"    $phase = 'timeout-alive'",
		"  }",
		"  $hint = '可用 --patch 叠加最小配置逐个排查插件；tail 见下'",
		"  Write-Log $message",
		"  Write-Status -Phase $phase -Message $message -Extra @{",
		renderProbeObject("    "),
		"    child = @{ pid = $dshProcess.Id; exitCode = $dshProcess.ExitCode; outLog = $childOut; errLog = $childErr; tail = $tail }",
		"    port = (Get-PortOwner)",
		"    hint = $hint",
		"  }",
		"  Show-Message ($message + [char]10 + $tail + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"  return 1",
		"}",
		"",
		"$mutexName = 'Local\\DSH-Web-Launcher-' + $port",
		"$mutex = $null",
		"$ownsMutex = $false",
		"try {",
		"  $mutex = New-Object System.Threading.Mutex($false, $mutexName)",
		"  $ownsMutex = $mutex.WaitOne(0)",
		"} catch { $ownsMutex = $false }",
		"",
		"$exitCode = 1",
		"try {",
		"  if ($ownsMutex) { $exitCode = Invoke-Launch } else { $exitCode = Wait-ExistingInstance }",
		"} catch {",
		"  $message = '启动流程异常：' + $_",
		"  Write-Log $message",
		"  Write-Status -Phase 'error' -Message $message -Extra @{ hint = '查看 launcher.log 与 dsh-child 日志' }",
		"  Show-Message ($message + [char]10 + '日志：' + $log) 'DSH Quick Launcher'",
		"  $exitCode = 1",
		"} finally {",
		"  if ($ownsMutex -and $mutex -ne $null) { try { $mutex.ReleaseMutex() } catch {} }",
		"  if ($mutex -ne $null) { try { $mutex.Dispose() } catch {} }",
		"}",
		"exit $exitCode",
		""
	].join("\n");
}
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
function renderRestartHelper(spec) {
	return [
		"# DSH web restart helper (generated by dsh-desktop_quick_launcher v0.2)",
		"$ErrorActionPreference = 'Continue'",
		`$port = ${spec.port}`,
		`$url = ${psSingle(spec.url)}`,
		`$oldHostPid = ${spec.hostPid}`,
		`$graceMs = ${spec.graceMs}`,
		`$dshCommand = ${psSingle(spec.dshCommand)}`,
		`$dshProfile = ${psSingle(spec.profile ?? "")}`,
		`$instanceIdBefore = ${psSingle(spec.instanceIdBefore)}`,
		`$waitSeconds = ${spec.waitSeconds}`,
		`$dshHome = ${psSingle(spec.dshHome)}`,
		`$hostCwd = ${psSingle(spec.cwd)}`,
		"$scriptDir = $PSScriptRoot",
		"$selfPid = $PID",
		`$log = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.helperLog)}`,
		`$statusPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.restartStatus)}`,
		`$inflightPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.restartInflight)}`,
		`$childOut = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childOut)}`,
		`$childErr = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.childErr)}`,
		`$authPath = Join-Path $scriptDir ${psSingle(LAUNCHER_FILES.authUrl)}`,
		`$pingPath = ${psSingle(PLUGIN_ROUTE_PREFIX + "/ping")}`,
		`$pluginId = ${psSingle("dsh-desktop_quick_launcher")}`,
		`$fingerprint = ${psSingle("dsh web authentication required")}`,
		"",
		"function Write-Log {",
		"  param([string]$Message)",
		"  try { Add-Content -Path $log -Value (('[dsh-restart] ' + (Get-Date -Format 's') + ' | ' + $Message)) -Encoding UTF8 } catch {}",
		"}",
		"",
		"function Read-State {",
		"  if (-not (Test-Path -LiteralPath $statusPath)) { return $null }",
		"  try { return (Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }",
		"}",
		"",
		"function Save-State {",
		"  param([string]$Phase, $Extra)",
		"  try {",
		"    $state = Read-State",
		"    if ($state -eq $null) { $state = New-Object System.Object }",
		"    $state | Add-Member -NotePropertyName schema -NotePropertyValue 1 -Force",
		"    $state | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force",
		"    $state | Add-Member -NotePropertyName phase -NotePropertyValue $Phase -Force",
		"    if ($Extra -ne $null) {",
		"      foreach ($key in $Extra.Keys) { $state | Add-Member -NotePropertyName $key -NotePropertyValue $Extra[$key] -Force }",
		"    }",
		renderAtomicJsonWriter("    "),
		"  } catch {",
		"    Write-Log ('state write failed: ' + $_)",
		"  }",
		"}",
		"",
		"function Clear-Inflight {",
		"  try { Remove-Item -LiteralPath $inflightPath -Force -ErrorAction SilentlyContinue } catch {}",
		"}",
		"",
		"function Get-AuthUrl {",
		"  if (-not (Test-Path -LiteralPath $childOut)) { return \"\" }",
		"  try {",
		"    $found = Select-String -LiteralPath $childOut -Pattern '^dsh web:\\s*(\\S+)' | Select-Object -First 1",
		"    if ($found -ne $null) { return [string]$found.Matches[0].Groups[1].Value }",
		"  } catch {}",
		"  return \"\"",
		"}",
		"",
		renderProbeFunctions(),
		"Write-Log ('helper started pid=' + $selfPid + ' oldHostPid=' + $oldHostPid + ' port=' + $port)",
		"$state = Read-State",
		"if ($state -ne $null -and $state.phase -eq 'aborted-busy') { Write-Log 'host already aborted the restart'; Clear-Inflight; exit 0 }",
		"Save-State -Phase 'verifying-old' -Extra @{}",
		"Start-Sleep -Milliseconds ($graceMs + 2000)",
		"$state = Read-State",
		"if ($state -ne $null -and $state.phase -eq 'aborted-busy') { Write-Log 'host aborted the restart during the grace period'; Clear-Inflight; exit 0 }",
		"",
		"$waited = 0",
		"while ($waited -lt 30000 -and (Test-TcpPort $port)) { Start-Sleep -Milliseconds 500; $waited += 500 }",
		"if (Test-TcpPort $port) {",
		"  Write-Log 'old instance still listening -> fallback kill (deliberately without /T)'",
		"  Save-State -Phase 'killing' -Extra @{}",
		"  $killed = @()",
		"  try {",
		"    $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $oldHostPid) -ErrorAction SilentlyContinue)",
		"    foreach ($child in $children) {",
		"      if ([int]$child.ProcessId -eq $selfPid) { continue }",
		"      taskkill.exe /PID $child.ProcessId /F 2>&1 | Out-Null",
		"      $killed += @{ pid = [int]$child.ProcessId; name = [string]$child.Name; reason = 'child-of-old-host' }",
		"    }",
		"  } catch { Write-Log ('child enumeration failed: ' + $_) }",
		"  taskkill.exe /PID $oldHostPid /F 2>&1 | Out-Null",
		"  $killed += @{ pid = $oldHostPid; name = ''; reason = 'graceful-exit-timeout' }",
		"  Save-State -Phase 'killing' -Extra @{ killed = $killed }",
		"  $releaseWait = 0",
		"  while ($releaseWait -lt 15000 -and (Test-TcpPort $port)) { Start-Sleep -Milliseconds 500; $releaseWait += 500 }",
		"}",
		"if (Test-TcpPort $port) {",
		"  $message = '端口 ' + $port + ' 仍被占用，未能停止旧实例'",
		"  Write-Log $message",
		"  Save-State -Phase 'failed' -Extra @{ error = $message; hint = '请手动结束占用该端口的进程后重试' }",
		"  Clear-Inflight",
		"  exit 1",
		"}",
		"",
		"Save-State -Phase 'spawning' -Extra @{}",
		renderDshCommandResolver(),
		"if ($null -eq $command) {",
		"  Save-State -Phase 'failed' -Extra @{ error = ('找不到 dsh 命令：' + $dshCommand); hint = '确认 dsh 已加入 PATH 后重试' }",
		"  Clear-Inflight",
		"  exit 1",
		"}",
		renderSpawnArguments(),
		"$spawnStart = Get-Date",
		"# A scheduled task runs in %SystemRoot%\\System32 with no DSH_HOME set;",
		"# restore both before starting the replacement.",
		"try { Set-Location -LiteralPath $hostCwd } catch { Write-Log ('Set-Location failed: ' + $_) }",
		"$env:DSH_HOME = $dshHome",
		"$workingDir = $hostCwd",
		"if (-not (Test-Path -LiteralPath $workingDir)) { $workingDir = $scriptDir }",
		"try {",
		"  $newProcess = Start-Process -FilePath $filePath -ArgumentList $arguments -WorkingDirectory $workingDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $childOut -RedirectStandardError $childErr",
		"} catch {",
		"  Save-State -Phase 'failed' -Extra @{ error = ('启动新实例失败：' + $_); hint = '见 restart-helper.log' }",
		"  Clear-Inflight",
		"  exit 1",
		"}",
		"Write-Log ('spawned new dsh, pid=' + $newProcess.Id)",
		"Save-State -Phase 'spawning' -Extra @{ spawned = @{ pid = $newProcess.Id; command = $filePath; args = $arguments } }",
		"",
		"$deadline = (Get-Date).AddSeconds($waitSeconds)",
		"$ready = $false",
		"$probe = $null",
		"while ((Get-Date) -lt $deadline) {",
		"  Start-Sleep -Milliseconds 500",
		"  $probe = Get-Probe",
		"  if ($probe.probeClass -eq 'up-dsh' -and $probe.instanceId -ne '' -and $probe.instanceId -ne $instanceIdBefore) { $ready = $true; break }",
		"  if ($newProcess -ne $null -and $newProcess.HasExited) { break }",
		"}",
		"$authUrl = Get-AuthUrl",
		"$tail = Get-ChildTail 15",
		"if ($ready) {",
		"  Write-Log ('new instance ready: ' + $probe.instanceId)",
		"  Save-State -Phase 'ready' -Extra @{",
		"    ready = @{ instanceId = $probe.instanceId; pid = $newProcess.Id; waitedMs = [int]((Get-Date) - $spawnStart).TotalMilliseconds }",
		"    authUrl = $authUrl",
		"    childTail = $tail",
		"    error = ''",
		"    hint = ''",
		"  }",
		"  Clear-Inflight",
		"  exit 0",
		"}",
		"if ($newProcess -ne $null -and $newProcess.HasExited) {",
		"  $message = '新实例启动后退出（代码 ' + $newProcess.ExitCode + '）'",
		"  Write-Log $message",
		"  Save-State -Phase 'failed' -Extra @{ error = $message; childTail = $tail; hint = '见 restart-helper.log 与 dsh-child.err.log' }",
		"  Clear-Inflight",
		"  exit 1",
		"}",
		"$message = '新实例在 ' + $waitSeconds + ' 秒内未就绪'",
		"Write-Log $message",
		"Save-State -Phase 'timeout' -Extra @{ error = $message; childTail = $tail; hint = '见 restart-helper.log 与 dsh-child.err.log' }",
		"Clear-Inflight",
		"exit 1",
		""
	].join("\n");
}
/** POSIX launcher (macOS .command / Linux .sh) with the platform open command. */
function renderPosix(platform, spec) {
	const open = platform === "darwin" ? "open" : "xdg-open";
	const alert = platform === "darwin" ? "osascript -e 'display dialog \"dsh command not found: '\"$DASH\"'\" with title \"DSH Quick Launcher\" with icon caution' 2>/dev/null || echo \"dsh command not found: $DASH\" >&2" : "zenity --error --title=\"DSH Quick Launcher\" --text=\"dsh command not found: $DASH\" 2>/dev/null || echo \"dsh command not found: $DASH\" >&2";
	return [
		"#!/bin/bash",
		"# DSH web launcher (generated by dsh-desktop_quick_launcher)",
		`DASH=${shSingle(spec.dshCommand)}`,
		`URL=${shSingle(spec.url)}`,
		`PROFILE=${shSingle(spec.profile ?? "")}`,
		"",
		"probe() {",
		"  curl -fsS --max-time 2 \"$URL\" >/dev/null 2>&1",
		"}",
		"",
		"if probe; then",
		`  ${open} "$URL"`,
		"  exit 0",
		"fi",
		"",
		"if ! command -v \"$DASH\" >/dev/null 2>&1; then",
		`  ${alert}`,
		"  exit 1",
		"fi",
		"",
		"if [ -n \"$PROFILE\" ]; then",
		"  \"$DASH\" --profile \"$PROFILE\" --no-open >/dev/null 2>&1 &",
		"else",
		"  \"$DASH\" web --no-open >/dev/null 2>&1 &",
		"fi",
		"DASH_PID=$!",
		"",
		"for i in $(seq 1 60); do",
		"  if probe; then",
		`    ${open} "$URL"`,
		"    exit 0",
		"  fi",
		"  if ! kill -0 \"$DASH_PID\" 2>/dev/null; then",
		"    echo \"dsh process exited unexpectedly\" >&2",
		"    exit 1",
		"  fi",
		"  sleep 2",
		"done",
		"",
		"echo \"dsh web did not start within 120 seconds: $URL\" >&2",
		"exit 1",
		""
	].join("\n");
}
/** Render the launcher script for one platform. */
function renderLauncherScript(platform, spec) {
	switch (platform) {
		case "win32": return renderPowerShell(spec);
		case "darwin":
		case "linux": return renderPosix(platform, spec);
	}
}
/** Render the Linux desktop entry (macOS uses the launcher itself as the desktop file). */
function renderDesktopEntry(launcherPath, iconPath) {
	const iconLine = iconPath === void 0 ? "Icon=utilities-terminal" : `Icon=${iconPath}`;
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Version=1.0",
		"Name=DSH Web",
		"Comment=Launch DeepSeek Harness Web GUI",
		`Exec="${launcherPath}"`,
		iconLine,
		"Terminal=true",
		"Categories=Development;",
		""
	].join("\n");
}
/**
* Render the Windows shortcut installer: a PowerShell script that creates the
* Desktop .lnk pointing at the launcher script, executed hidden by the host.
*/
function renderShortcutInstaller(opts) {
	const { launcherPath, desktopPath, workingDirectory, iconLocation } = opts;
	const targetWorkingDir = workingDirectory ?? "";
	return [
		"# DSH desktop shortcut installer (generated by dsh-desktop_quick_launcher)",
		"$ErrorActionPreference = 'Stop'",
		"$ws = New-Object -ComObject WScript.Shell",
		`$shortcut = $ws.CreateShortcut(${psSingle(desktopPath)})`,
		`$shortcut.TargetPath = ${psSingle("powershell.exe")}`,
		`$shortcut.Arguments = ${psSingle(`-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${launcherPath}`)}`,
		`$shortcut.WorkingDirectory = ${psSingle(targetWorkingDir)}`,
		`$shortcut.IconLocation = ${psSingle(iconLocation)}`,
		`$shortcut.Description = ${psSingle("Launch DeepSeek Harness Web GUI")}`,
		"$shortcut.Save()",
		""
	].join("\n");
}
//#endregion
//#region src/core/busy.ts
const TURN_START = "turn/start";
const TURN_END = "turn/end";
function timeOf(event) {
	if (event?.time === void 0) return void 0;
	const parsed = Date.parse(event.time);
	return Number.isNaN(parsed) ? void 0 : parsed;
}
/**
* Find every session with an open turn.
* @param sessions - live sessions as `{ id, events }` (events in log order).
* @param now - current epoch milliseconds, injected so the result is testable.
* @returns one entry per generating session, in input order.
*/
function findOpenTurns(sessions, now) {
	const open = [];
	for (const session of sessions) {
		const events = session.events;
		if (events.length === 0) continue;
		let boundary;
		let boundaryIndex = -1;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const type = events[index].type;
			if (type === TURN_START || type === TURN_END) {
				boundary = events[index];
				boundaryIndex = index;
				break;
			}
		}
		if (boundary === void 0 || boundary.type !== TURN_START) continue;
		const lastTime = timeOf(events[events.length - 1]);
		const startedTime = timeOf(boundary);
		const quietSource = lastTime ?? startedTime;
		open.push({
			sessionId: session.id,
			turn: typeof boundary.data?.turn === "number" ? boundary.data.turn : boundaryIndex,
			startedAt: boundary.time ?? new Date(startedTime ?? now).toISOString(),
			quietMs: quietSource === void 0 ? 0 : Math.max(0, now - quietSource)
		});
	}
	return open;
}
//#endregion
//#region src/index.ts
/**
* dsh-desktop_quick_launcher — host half.
*
* Migrated core logic from the retired @linxin666/dsh-desktop-launcher
* (Apache-2.0). Serves a loopback-only API family under
* /api/dsh-desktop_quick_launcher:
*
*   - GET  /ping      instance identity + the per-instance nonce (readiness
*                     probe for the launcher, the restart helper, and the GUI
*                     after a restart);
*   - GET  /status    instance + busy (open turns) + last launcher report +
*                     restart progress + port owner + log paths;
*   - POST /create    writes the launcher script under
*                     <dsh-home>/desktop-quick-launcher/ and places a
*                     double-click icon on the Desktop;
*   - POST /restart   hands over to a detached restart helper, then exits
*                     gracefully; refused with 409 while a turn is open;
*   - POST /shutdown  asks the host process to exit gracefully (ctx.appExit,
*                     process.exit(0) fallback) after the response is flushed.
*
* State-changing routes require the `x-dsh-ql-nonce` header. NOTE: these routes
* are NOT behind the browser login gate (only the loopback fence); the nonce
* defends against a cross-site page blindly POSTing to 127.0.0.1, not against a
* local process, which can read /ping itself.
*
* The plugin also owns a schemastery settings section (`desktop-quick-launcher`)
* and an optional system-prompt section. The browser half (./client) renders the
* floating panel. Everything rides the official DSH SDK packages; no dsh source
* changes.
*/
const execFileAsync = promisify(execFile);
/** Stable cordis plugin name. */
const name = "dsh-desktop_quick_launcher";
/** Host services this plugin consumes. `sessions` is read optionally at runtime. */
const inject = ["webServer", "systemPrompt"];
/** Wire contract between host routes and the browser API helpers. */
const LAUNCHER_API = {
	/** Instance identity + nonce. */
	ping: `${PLUGIN_ROUTE_PREFIX}/ping`,
	/** Full status snapshot (instance, busy, reports, logs). */
	status: `${PLUGIN_ROUTE_PREFIX}/status`,
	/** Create (or refresh) the desktop icon. */
	create: `${PLUGIN_ROUTE_PREFIX}/create`,
	/** Hand over to the restart helper and exit. */
	restart: `${PLUGIN_ROUTE_PREFIX}/restart`,
	/** Request the host process to exit gracefully. */
	shutdown: `${PLUGIN_ROUTE_PREFIX}/shutdown`,
	/** List the plugin's own log/status files. */
	logs: `${PLUGIN_ROUTE_PREFIX}/logs`,
	/** Truncate log files (or delete status files). */
	logsClear: `${PLUGIN_ROUTE_PREFIX}/logs/clear`,
	/** Reveal the log directory in the file manager. */
	logsOpen: `${PLUGIN_ROUTE_PREFIX}/logs/open`,
	/** Read or write the panel's own display options. */
	options: `${PLUGIN_ROUTE_PREFIX}/options`
};
/** Config fields the settings card may write. */
const OPTION_FIELDS = [
	"showDetailsButton",
	"showStopButton",
	"showRestartButton",
	"showLaunchReport"
];
/** Largest log payload returned by one /logs?name= read. */
const MAX_LOG_CHARS = 2e5;
/** Nonce header required by every state-changing route. */
const NONCE_HEADER = "x-dsh-ql-nonce";
/** Plugin version, mirrored from package.json by hand. */
const PLUGIN_VERSION = "0.2.5";
/** How long a restart handover marker blocks a second restart. */
const INFLIGHT_TTL_MS = 9e4;
/**
* How long the host waits for the helper to prove it is running before it
* cancels the restart. This is the safety net that keeps a broken survivor
* mechanism from leaving the user with a dead service: the host stays alive.
*/
const DEFAULT_HELPER_START_TIMEOUT_MS = 8e3;
/** Delay between the 202 acknowledgement and the pre-exit busy re-check. */
const RECHECK_DELAY_MS = 1e3;
/** How long the exit request waits after the response is flushed. */
const EXIT_DELAY_MS = 500;
const Config = z.object({
	enabled: z.boolean().default(true),
	announceToAgent: z.boolean().default(false),
	dshCommand: z.string().default("dsh"),
	url: z.string().default(DEFAULT_URL),
	profile: z.string().default(""),
	iconPath: z.string().default(""),
	confirmShutdown: z.boolean().default(true),
	restartGraceMs: z.natural().default(DEFAULT_GRACE_MS),
	restartTimeoutSec: z.natural().default(150),
	busyPolicy: z.string().default("block"),
	restartMethod: z.string().default("auto"),
	helperStartTimeoutMs: z.natural().default(DEFAULT_HELPER_START_TIMEOUT_MS),
	showDetailsButton: z.boolean().default(true),
	showStopButton: z.boolean().default(true),
	showRestartButton: z.boolean().default(true),
	showLaunchReport: z.boolean().default(true)
});
/** Settings namespace owned by this plugin (host + browser spell the same value). */
const NAMESPACE = "desktop-quick-launcher";
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210;
const DESKTOP_QUICK_LAUNCHER_GUIDANCE = "本机已安装 desktop-quick-launcher 插件（DSH 桌面快捷启动 + 一键重启/退出）：「设置 → 插件配置」可配置 dshCommand / url / profile；界面右下角悬浮面板可「生成/刷新桌面图标」（Windows .lnk 双击即启动 dsh web 并打开浏览器）、「重启服务」（宿主优雅退出后由独立助手拉起新实例，页面自动回到原会话）、「停止 DSH 服务」（确认后请求宿主进程优雅退出）。安全与限制：图标创建、重启、退出接口均仅限本机回环访问且需要一次性 nonce；只要有回答正在生成（session 存在未结束的回合），重启与退出会被拒绝（返回 409），必须先等回答结束或在界面里选择「等空闲后自动重启」。用户提到「桌面图标 / 快捷方式 / 一键启动 / 重启 DSH / 退出 DSH」时即指本插件。";
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/** Loopback trust fence: socket address AND Host header AND same-origin markers. */
function isLoopbackRequest(request) {
	const remote = request.socket.remoteAddress;
	if (remote === void 0) return false;
	const address = remote.toLowerCase();
	if (!(address === "::1" || address.startsWith("::ffff:") && isIPv4Loopback(address.slice(7)) || isIPv4Loopback(address))) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
function writeJson(res, status, body) {
	res.writeHead(status, JSON_HEADERS);
	res.end(JSON.stringify(body));
}
/** Resolve $DSH_HOME with a ~/.dsh fallback. */
function dshHome(env = process.env, home = homedir()) {
	const raw = env.DSH_HOME;
	if (raw !== void 0 && raw.trim() !== "") {
		const expanded = raw.trim().startsWith("~") ? join(home, raw.trim().slice(1).replace(/^[\\/]/, "")) : raw.trim();
		return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
	}
	return join(home, ".dsh");
}
/** Run a command, capturing exit code and stderr (30 s cap). */
async function runCommand(file, args) {
	try {
		await execFileAsync(file, args, {
			timeout: 3e4,
			windowsHide: true
		});
		return {
			code: 0,
			stderr: ""
		};
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
		return {
			code: typeof code === "number" ? code : null,
			stderr: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Read a JSON request body; never throws, never blocks the response. */
async function readJsonBody(request, limitBytes = 4096) {
	return await new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > limitBytes) {
				resolve({});
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {});
			} catch {
				resolve({});
			}
		});
		request.on("error", () => {
			resolve({});
		});
	});
}
/** Clamp a possibly-absent numeric body field. */
function clampNumber(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}
/** The dsh icon bundled with the package (assets/ next to lib/). */
let bundledIconPath;
let bundledPngPath;
if (import.meta.url.startsWith("file:")) {
	try {
		bundledIconPath = fileURLToPath(new URL("../assets/dsh.ico", import.meta.url));
	} catch {}
	try {
		bundledPngPath = fileURLToPath(new URL("../assets/dsh.png", import.meta.url));
	} catch {}
}
function resolveIconSource(configured) {
	if (configured !== void 0 && configured !== "" && existsSync(configured)) return configured;
	return bundledIconPath !== void 0 && existsSync(bundledIconPath) ? bundledIconPath : void 0;
}
function toLauncherPlatform(platform) {
	if (platform === "win32" || platform === "darwin" || platform === "linux") return platform;
	throw new Error(`unsupported platform: ${platform}`);
}
/** Desktop directory with the Windows OneDrive redirect fallback. */
function resolveDesktopDir(home, platform) {
	const desktop = join(home, "Desktop");
	if (platform === "win32" && !existsSync(desktop)) {
		const onedrive = join(home, "OneDrive", "Desktop");
		if (existsSync(onedrive)) return onedrive;
	}
	return desktop;
}
/** Best-effort dsh probe on PATH (never throws). */
async function probeDsh(platform, dshCommand) {
	if (isAbsolute(dshCommand) || dshCommand.includes("/") || dshCommand.includes("\\")) return existsSync(dshCommand);
	try {
		return (platform === "win32" ? await runCommand("where", [dshCommand]) : await runCommand("sh", [
			"-lc",
			"command -v -- \"$1\"",
			"desktop-quick-launcher",
			dshCommand
		])).code === 0;
	} catch {
		return false;
	}
}
/** Write the launcher script + place the desktop icon for the current platform. */
async function createDesktopShortcut(specSource) {
	const spec = specSource();
	const platform = toLauncherPlatform(process.platform);
	const home = homedir();
	const scriptsDir = join(dshHome(), "desktop-quick-launcher");
	await mkdir(scriptsDir, { recursive: true });
	const launcherPath = join(scriptsDir, scriptFileName(platform));
	await writeFile(launcherPath, "﻿" + renderLauncherScript(platform, spec), { mode: 493 });
	let iconIco;
	let iconPng;
	const iconSource = resolveIconSource(spec.iconPath);
	if (iconSource !== void 0) {
		iconIco = join(scriptsDir, LAUNCHER_FILES.icon);
		await copyFile(iconSource, iconIco);
		if (/\.png$/i.test(iconSource)) {
			iconPng = join(scriptsDir, LAUNCHER_FILES.iconPng);
			await copyFile(iconSource, iconPng);
		} else if (bundledPngPath !== void 0 && existsSync(bundledPngPath)) {
			iconPng = join(scriptsDir, LAUNCHER_FILES.iconPng);
			await copyFile(bundledPngPath, iconPng);
		}
	}
	const desktopDir = resolveDesktopDir(home, platform);
	await mkdir(desktopDir, { recursive: true });
	const iconPath = join(desktopDir, desktopFileName(platform));
	let warning;
	if (!await probeDsh(platform, spec.dshCommand)) warning = `dsh command "${spec.dshCommand}" was not found on PATH; the launcher shows a message when run`;
	if (platform === "win32") {
		const installerPath = join(scriptsDir, LAUNCHER_FILES.shortcutInstaller);
		await writeFile(installerPath, "﻿" + renderShortcutInstaller({
			launcherPath,
			desktopPath: iconPath,
			workingDirectory: scriptsDir,
			iconLocation: iconIco ?? "powershell.exe,0"
		}));
		const result = await runCommand("powershell", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			installerPath
		]);
		if (result.code !== 0) throw new Error(`shortcut creation failed: ${result.stderr}`);
	} else if (platform === "darwin") await writeFile(iconPath, renderLauncherScript(platform, spec), { mode: 493 });
	else {
		await writeFile(iconPath, renderDesktopEntry(launcherPath, iconPng ?? iconIco), { mode: 493 });
		await chmod(launcherPath, 493);
		const trust = await runCommand("gio", [
			"set",
			iconPath,
			"metadata::trusted",
			"true"
		]);
		if (trust.code !== 0) warning = `desktop entry created but not marked trusted: ${trust.stderr}`;
	}
	return {
		ok: true,
		path: iconPath,
		platform,
		...warning === void 0 ? {} : { warning }
	};
}
/**
* Refresh an already-installed launcher script in place.
*
* The desktop shortcut points at a fixed path, so rewriting the script is what
* makes an upgrade take effect — without it a shortcut keeps running whatever
* version existed when the icon was created (which is exactly how a fixed
* launcher kept failing: the icon was still running a script from two releases
* earlier). Called on every boot; it never creates the icon itself.
* @param specSource - resolves the current launcher spec.
* @returns what happened, or null when no icon has been created yet.
*/
async function refreshLauncherScript(specSource) {
	const platform = toLauncherPlatform(process.platform);
	const scriptsDir = join(dshHome(), "desktop-quick-launcher");
	const launcherPath = join(scriptsDir, scriptFileName(platform));
	if (!existsSync(launcherPath)) return null;
	const body = "﻿" + renderLauncherScript(platform, specSource());
	try {
		if (await readFile(launcherPath, "utf8") === body) return {
			path: launcherPath,
			updated: false
		};
	} catch {}
	await mkdir(scriptsDir, { recursive: true });
	await writeFile(launcherPath, body, { mode: 493 });
	return {
		path: launcherPath,
		updated: true
	};
}
/**
* Mount the routes, the settings section, and the (optional) system-prompt
* section.
* @param ctx - host plugin context carrying webServer/systemPrompt.
* @param config - resolved plugin config.
* @param hooks - test-only overrides for the spawn/exit side effects.
*/
function apply(ctx, config, hooks) {
	let current = () => config ?? {};
	const disposers = [];
	let disposeSection;
	/** Identity of THIS process; a changed instanceId is the readiness proof. */
	const instanceId = randomUUID();
	/** One-time token every state-changing route requires. */
	const nonce = randomUUID();
	const startedAt = Date.now();
	let exitRequested = false;
	const requestExit = (code) => {
		if (exitRequested) return;
		exitRequested = true;
		if (hooks?.requestExit !== void 0) {
			hooks.requestExit(code);
			return;
		}
		const exit = ctx.get("appExit");
		if (exit !== void 0) {
			exit(code);
			return;
		}
		process.exit(code);
	};
	const scriptsDir = () => join(dshHome(), "desktop-quick-launcher");
	const pathIn = (file) => join(scriptsDir(), file);
	/**
	* Token URL of this instance, as `dsh web` prints it. Resolved from the
	* connection service so the launcher can open an already-authenticated page
	* instead of the bare origin — which answers 401 on a fresh browser profile.
	*/
	let authUrl = null;
	let authUrlWritten = null;
	/** Persist the token URL so a launcher/helper can open an authenticated page. */
	const rememberAuthUrl = () => {
		if (authUrl === null || authUrl === authUrlWritten) return;
		const value = authUrl;
		authUrlWritten = value;
		(async () => {
			try {
				await mkdir(scriptsDir(), { recursive: true });
				await writeFile(pathIn(LAUNCHER_FILES.authUrl), value, "utf8");
			} catch {}
		})();
	};
	ctx.inject(["connection"], (connectionCtx) => {
		const connection = connectionCtx.connection;
		if (connection === void 0 || typeof connection.authenticatedUrl !== "function") return;
		try {
			authUrl = connection.authenticatedUrl(`http://127.0.0.1:${resolvedPort()}`);
		} catch {
			authUrl = null;
		}
		rememberAuthUrl();
	});
	const launcherStatusPath = () => pathIn(LAUNCHER_FILES.launcherStatus);
	const restartStatusPath = () => pathIn(LAUNCHER_FILES.restartStatus);
	const inflightPath = () => pathIn(LAUNCHER_FILES.restartInflight);
	const helperPath = () => pathIn(LAUNCHER_FILES.restartHelper);
	/** Name of the scheduled task that carries the restart helper. */
	const restartTaskName = () => `DSH-Web-Restart-${portFromUrl(current().url ?? "http://127.0.0.1:3080")}`;
	/**
	* Files the GUI may read or clear. A strict whitelist keyed by short names:
	* the routes never accept a caller-supplied path, so no request can reach
	* outside the plugin's own directory.
	*/
	const LOG_FILES = {
		launcher: LAUNCHER_FILES.launcherLog,
		restart: LAUNCHER_FILES.helperLog,
		childOut: LAUNCHER_FILES.childOut,
		childErr: LAUNCHER_FILES.childErr,
		launcherStatus: LAUNCHER_FILES.launcherStatus,
		restartStatus: LAUNCHER_FILES.restartStatus,
		inflight: LAUNCHER_FILES.restartInflight
	};
	const logPath = (key) => typeof key === "string" && Object.hasOwn(LOG_FILES, key) ? pathIn(LOG_FILES[key]) : void 0;
	/** Real listening port, falling back to the configured URL. */
	const resolvedPort = () => {
		try {
			const port = ctx.webServer.port;
			if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
		} catch {}
		return portFromUrl(current().url ?? "http://127.0.0.1:3080");
	};
	/** Config plus the live port, as the launcher/helper generators need it. */
	const launcherSpec = () => resolveLauncherSpec({
		...current(),
		port: resolvedPort()
	});
	const restartSpec = (graceMs) => {
		const value = current();
		return {
			port: resolvedPort(),
			url: value.url ?? "http://127.0.0.1:3080",
			hostPid: process.pid,
			graceMs,
			dshCommand: value.dshCommand ?? "dsh",
			...value.profile === void 0 || value.profile === "" ? {} : { profile: value.profile },
			instanceIdBefore: instanceId,
			waitSeconds: value.restartTimeoutSec ?? 150,
			cwd: process.cwd(),
			dshHome: dshHome()
		};
	};
	/**
	* Is an answer being generated right now?
	*
	* Fails OPEN (`known:false`) when the sessions service is unreachable or its
	* API changed: a fail-closed check would disable restart forever, which is a
	* worse failure than a missed interruption. The reason is recorded and shown.
	*/
	const busySnapshot = (now) => {
		const checkedAt = new Date(now).toISOString();
		let store;
		try {
			store = ctx.get("sessions");
		} catch {
			store = void 0;
		}
		if (store === void 0 || typeof store.list !== "function") return {
			known: false,
			check: "unavailable: sessions service not present",
			generating: false,
			openTurns: [],
			checkedAt
		};
		try {
			const views = [];
			for (const raw of store.list()) {
				const session = raw;
				if (typeof session.id !== "string" || typeof session.snapshotEvents !== "function") continue;
				const events = session.snapshotEvents();
				views.push({
					id: session.id,
					events: Array.isArray(events) ? events : []
				});
			}
			const openTurns = findOpenTurns(views, now);
			return {
				known: true,
				check: "sessions",
				generating: openTurns.length > 0,
				openTurns,
				checkedAt
			};
		} catch (error) {
			return {
				known: false,
				check: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
				generating: false,
				openTurns: [],
				checkedAt
			};
		}
	};
	/** Blocking mode, unless the operator asked for warnings only. */
	const blocksOnBusy = () => (current().busyPolicy ?? "block") !== "warn";
	const writeJsonFile = async (path, value) => {
		const temp = `${path}.tmp`;
		await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
		await rename(temp, path);
	};
	const readStatusFile = async (path) => {
		try {
			const parsed = parseStatusFile(await readFile(path, "utf8"));
			if (!parsed.ok) return {
				report: null,
				ageMs: null,
				readError: parsed.error
			};
			const updated = Date.parse(parsed.value.updatedAt);
			return {
				report: parsed.value,
				ageMs: Number.isNaN(updated) ? null : Math.max(0, Date.now() - updated),
				readError: null
			};
		} catch (error) {
			if (error.code === "ENOENT") return {
				report: null,
				ageMs: null,
				readError: null
			};
			return {
				report: null,
				ageMs: null,
				readError: error instanceof Error ? error.message : String(error)
			};
		}
	};
	const readInflight = async () => {
		try {
			const raw = JSON.parse(stripBom(await readFile(inflightPath(), "utf8")));
			const at = typeof raw.at === "string" ? Date.parse(raw.at) : NaN;
			const ttlMs = typeof raw.ttlMs === "number" ? raw.ttlMs : INFLIGHT_TTL_MS;
			if (Number.isNaN(at) || Date.now() - at >= ttlMs) return null;
			return {
				instanceId: typeof raw.instanceId === "string" ? raw.instanceId : "",
				helperPid: typeof raw.helperPid === "number" ? raw.helperPid : 0,
				at: typeof raw.at === "string" ? raw.at : "",
				ttlMs
			};
		} catch {
			return null;
		}
	};
	const clearInflight = async () => {
		try {
			await rm(inflightPath(), { force: true });
		} catch {}
	};
	/** Merge one phase update into restart-status.json. */
	const writeRestartPhase = async (phase, extra) => {
		try {
			let base = {};
			try {
				base = JSON.parse(stripBom(await readFile(restartStatusPath(), "utf8")));
			} catch {}
			await writeJsonFile(restartStatusPath(), {
				...base,
				schema: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
				phase,
				...extra
			});
		} catch {}
	};
	/**
	* Spawn the restart helper so that it outlives this process.
	*
	* L1 is a detached child (its own process group); L2 is a scheduled task,
	* which is parented by the Task Scheduler service and therefore immune to the
	* old host's process-tree cleanup. `restartMethod` can pin either one.
	*/
	const spawnSurvivor = async (file) => {
		if (hooks?.spawnSurvivor !== void 0) return await hooks.spawnSurvivor(file);
		return await defaultSpawnSurvivor(file);
	};
	/**
	* The production survivor ladder.
	*
	* The scheduled task is tried FIRST: its process is parented by the Task
	* Scheduler service, so the host's own teardown cannot take it down. A
	* detached child (the `detached` pin, and the fallback when schtasks is
	* unavailable) is measurably less reliable on Windows — a detached helper was
	* observed to be killed together with the host's process tree before it
	* executed a single statement. The caller therefore verifies that the helper
	* actually started and cancels the restart otherwise.
	*/
	const defaultSpawnSurvivor = async (file) => {
		const method = current().restartMethod ?? "auto";
		const powershellArgs = [
			...HIDDEN_POWERSHELL_ARGS,
			"-File",
			file
		];
		if (method !== "detached") try {
			const taskName = restartTaskName();
			const created = await runCommand("schtasks", [
				"/create",
				"/f",
				"/tn",
				taskName,
				"/tr",
				renderScheduledTaskCommand(file),
				"/sc",
				"once",
				"/st",
				"00:00"
			]);
			if (created.code !== 0) throw new Error(`schtasks /create failed: ${created.stderr}`);
			const ran = await runCommand("schtasks", [
				"/run",
				"/tn",
				taskName
			]);
			if (ran.code !== 0) throw new Error(`schtasks /run failed: ${ran.stderr}`);
			return {
				pid: 0,
				method: "schtasks"
			};
		} catch (error) {
			if (method === "schtasks") throw error;
		}
		const child = spawn("powershell.exe", powershellArgs, {
			detached: true,
			windowsHide: true,
			stdio: "ignore"
		});
		child.on("error", () => {});
		await new Promise((resolve, reject) => {
			child.once("spawn", () => {
				resolve();
			});
			child.once("error", (error) => {
				reject(error);
			});
		});
		child.unref();
		if (typeof child.pid === "number" && child.pid > 0) return {
			pid: child.pid,
			method: "detached"
		};
		throw new Error("detached spawn returned no pid");
	};
	/**
	* Wait until the helper proves it is running, i.e. until it moves the shared
	* status file past `handoff`. Without this gate a broken survivor mechanism
	* kills the host and never replaces it, leaving the user with a dead service.
	* @param timeoutMs - how long to wait.
	* @returns true when the helper wrote a later phase.
	*/
	const waitForHelperStart = async (timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => {
				setTimeout(resolve, 200);
			});
			const phase = (await readStatusFile(restartStatusPath())).report?.phase;
			if (typeof phase === "string" && phase !== "handoff") return true;
		}
		return false;
	};
	/** Nonce check for state-changing routes. */
	const nonceOk = (request) => request.headers[NONCE_HEADER] === nonce;
	/** Shared guard for POST routes: loopback fence, method, nonce. */
	const guardPost = (request, res) => {
		if ((request.method ?? "GET") !== "POST") {
			writeJson(res, 405, { error: `method not allowed: ${request.method}` });
			return false;
		}
		if (!isLoopbackRequest(request)) {
			writeJson(res, 403, {
				ok: false,
				code: "forbidden",
				error: "forbidden: loopback-only"
			});
			return false;
		}
		if (!nonceOk(request)) {
			writeJson(res, 403, {
				ok: false,
				code: "nonce-required",
				error: `missing or stale ${NONCE_HEADER} header`
			});
			return false;
		}
		return true;
	};
	/** Shared guard for GET routes: method + loopback fence. */
	const guardGet = (request, res) => {
		if ((request.method ?? "GET") !== "GET") {
			writeJson(res, 405, { error: `method not allowed: ${request.method}` });
			return false;
		}
		if (!isLoopbackRequest(request)) {
			writeJson(res, 403, {
				ok: false,
				code: "forbidden",
				error: "forbidden: loopback-only"
			});
			return false;
		}
		return true;
	};
	/** Instance identity payload shared by /ping and /status. */
	const instanceInfo = () => ({
		ok: true,
		plugin: name,
		pluginVersion: PLUGIN_VERSION,
		instanceId,
		nonce,
		pid: process.pid,
		port: resolvedPort(),
		host: "127.0.0.1",
		startedAt: new Date(startedAt).toISOString(),
		uptimeMs: Date.now() - startedAt,
		authUrl
	});
	/** Config echo shared by /status and /options. */
	const configEcho = () => {
		const value = current();
		return {
			dshCommand: value.dshCommand ?? "dsh",
			url: value.url ?? "http://127.0.0.1:3080",
			profile: value.profile ?? "",
			confirmShutdown: value.confirmShutdown ?? true,
			busyPolicy: value.busyPolicy ?? "block",
			restartMethod: value.restartMethod ?? "auto",
			showDetailsButton: value.showDetailsButton ?? true,
			showStopButton: value.showStopButton ?? true,
			showRestartButton: value.showRestartButton ?? true,
			showLaunchReport: value.showLaunchReport ?? true,
			helperStartTimeoutMs: value.helperStartTimeoutMs ?? DEFAULT_HELPER_START_TIMEOUT_MS
		};
	};
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		while (disposers.length > 0) {
			const dispose = disposers.pop();
			try {
				dispose?.();
			} catch {}
		}
		const pingRoute = {
			kind: "exact",
			path: LAUNCHER_API.ping,
			handler: (req, res) => {
				if ((req.method ?? "GET") !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, {
						ok: false,
						code: "forbidden",
						error: "forbidden: loopback-only"
					});
					return;
				}
				rememberAuthUrl();
				writeJson(res, 200, instanceInfo());
			}
		};
		const statusRoute = {
			kind: "exact",
			path: LAUNCHER_API.status,
			handler: async (req, res) => {
				if ((req.method ?? "GET") !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, {
						ok: false,
						code: "forbidden",
						error: "forbidden: loopback-only"
					});
					return;
				}
				const now = Date.now();
				const [launcher, restart, inflight] = await Promise.all([
					readStatusFile(launcherStatusPath()),
					readStatusFile(restartStatusPath()),
					readInflight()
				]);
				current();
				writeJson(res, 200, {
					...instanceInfo(),
					busy: busySnapshot(now),
					config: configEcho(),
					port: {
						listening: true,
						ownerPid: process.pid,
						ownerName: "node",
						isSelf: true
					},
					launcher: {
						statusPath: launcherStatusPath(),
						...launcher
					},
					restart: {
						statusPath: restartStatusPath(),
						inflight,
						...restart
					},
					logs: {
						dir: scriptsDir(),
						launcherLog: pathIn(LAUNCHER_FILES.launcherLog),
						restartLog: pathIn(LAUNCHER_FILES.helperLog),
						childOut: pathIn(LAUNCHER_FILES.childOut),
						childErr: pathIn(LAUNCHER_FILES.childErr)
					}
				});
			}
		};
		const logsRoute = {
			kind: "exact",
			path: LAUNCHER_API.logs,
			handler: async (req, res) => {
				if (!guardGet(req, res)) return;
				const url = new URL(req.url ?? "/", "http://localhost");
				const key = url.searchParams.get("name");
				if (key === null) {
					const files = await Promise.all(Object.entries(LOG_FILES).map(async ([name, file]) => {
						const target = pathIn(file);
						try {
							const info = await stat(target);
							return {
								name,
								file: target,
								exists: true,
								size: info.size,
								mtime: info.mtime.toISOString()
							};
						} catch {
							return {
								name,
								file: target,
								exists: false,
								size: 0,
								mtime: null
							};
						}
					}));
					writeJson(res, 200, {
						ok: true,
						dir: scriptsDir(),
						files
					});
					return;
				}
				const target = logPath(key);
				if (target === void 0) {
					writeJson(res, 404, {
						ok: false,
						code: "unknown-log",
						error: `unknown log: ${key}`
					});
					return;
				}
				const requested = Number(url.searchParams.get("tail") ?? "200");
				const tail = clampNumber(Number.isFinite(requested) ? requested : 200, 200, 1, 2e3);
				try {
					const text = await readFile(target, "utf8");
					const clipped = text.length > MAX_LOG_CHARS ? text.slice(-2e5) : text;
					writeJson(res, 200, {
						ok: true,
						name: key,
						file: target,
						size: text.length,
						truncated: text.length > MAX_LOG_CHARS,
						text: tailLines(clipped, tail)
					});
				} catch (error) {
					if (error.code === "ENOENT") {
						writeJson(res, 200, {
							ok: true,
							name: key,
							file: target,
							size: 0,
							truncated: false,
							text: ""
						});
						return;
					}
					writeJson(res, 500, {
						ok: false,
						code: "read-failed",
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		};
		const logsClearRoute = {
			kind: "exact",
			path: LAUNCHER_API.logsClear,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				const body = await readJsonBody(req);
				const requested = Array.isArray(body.names) ? body.names : Object.keys(LOG_FILES);
				const cleared = [];
				for (const name of requested) {
					const target = logPath(name);
					if (target === void 0) continue;
					try {
						if (target.endsWith(".json")) await rm(target, { force: true });
						else await writeFile(target, "", "utf8");
						cleared.push(String(name));
					} catch {}
				}
				writeJson(res, 200, {
					ok: true,
					cleared
				});
			}
		};
		const logsOpenRoute = {
			kind: "exact",
			path: LAUNCHER_API.logsOpen,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				const dir = scriptsDir();
				const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
				try {
					await mkdir(dir, { recursive: true });
					await runCommand(opener, [dir]);
					writeJson(res, 200, {
						ok: true,
						dir
					});
				} catch (error) {
					writeJson(res, 500, {
						ok: false,
						code: "open-failed",
						error: error instanceof Error ? error.message : String(error),
						dir
					});
				}
			}
		};
		const optionsRoute = {
			kind: "exact",
			path: LAUNCHER_API.options,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				const body = await readJsonBody(req);
				const patch = {};
				for (const [key, value] of Object.entries(body)) {
					if (!OPTION_FIELDS.includes(key)) {
						writeJson(res, 400, {
							ok: false,
							code: "unknown-option",
							error: `unknown option: ${key}`
						});
						return;
					}
					if (typeof value !== "boolean") {
						writeJson(res, 400, {
							ok: false,
							code: "invalid-value",
							error: `${key} must be a boolean`
						});
						return;
					}
					patch[key] = value;
				}
				if (Object.keys(patch).length === 0) {
					writeJson(res, 400, {
						ok: false,
						code: "empty-patch",
						error: "no options given"
					});
					return;
				}
				const settings = ctx.get("settings");
				if (settings === void 0 || typeof settings.update !== "function") {
					writeJson(res, 503, {
						ok: false,
						code: "settings-unavailable",
						error: "the settings service is not available"
					});
					return;
				}
				try {
					await settings.update(NAMESPACE, patch);
					writeJson(res, 200, {
						ok: true,
						applied: patch,
						config: configEcho()
					});
				} catch (error) {
					writeJson(res, 500, {
						ok: false,
						code: "write-failed",
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		};
		const createRoute = {
			kind: "exact",
			path: LAUNCHER_API.create,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				try {
					writeJson(res, 200, { result: await createDesktopShortcut(launcherSpec) });
				} catch (error) {
					writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		};
		const restartRoute = {
			kind: "exact",
			path: LAUNCHER_API.restart,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				const body = await readJsonBody(req);
				const force = body.force === true;
				const graceMs = clampNumber(body.graceMs, current().restartGraceMs ?? 1500, 200, 3e4);
				const busy = busySnapshot(Date.now());
				if (blocksOnBusy() && busy.generating && !force) {
					writeJson(res, 409, {
						ok: false,
						code: "busy",
						busy,
						hint: "有回答正在生成；等它结束后再重启，或在界面里选择「等空闲后自动重启」"
					});
					return;
				}
				const inflight = await readInflight();
				if (inflight !== null && !force) {
					writeJson(res, 409, {
						ok: false,
						code: "restart-inflight",
						inflight
					});
					return;
				}
				try {
					await mkdir(scriptsDir(), { recursive: true });
					await writeJsonFile(restartStatusPath(), {
						schema: 1,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
						phase: "handoff",
						instanceIdBefore: instanceId,
						hostPid: process.pid,
						busyCheck: busy.check,
						busyAtHandoff: busy,
						forced: force,
						message: force ? "已按用户确认强制重启" : "已移交重启助手"
					});
					await writeFile(helperPath(), "﻿" + renderRestartHelper(restartSpec(graceMs)));
					const helper = await spawnSurvivor(helperPath());
					await writeJsonFile(inflightPath(), {
						instanceId,
						helperPid: helper.pid,
						at: (/* @__PURE__ */ new Date()).toISOString(),
						ttlMs: INFLIGHT_TTL_MS
					});
					const startTimeout = current().helperStartTimeoutMs ?? DEFAULT_HELPER_START_TIMEOUT_MS;
					if (!await waitForHelperStart(startTimeout)) {
						const message = `重启助手在 ${Math.round(startTimeout / 1e3)} 秒内未开始工作，已取消本次重启（服务保持运行）`;
						await writeRestartPhase("failed", {
							error: message,
							hint: "检查任务计划是否可用（schtasks /run），或把 restartMethod 改为 detached"
						});
						await clearInflight();
						writeJson(res, 500, {
							ok: false,
							code: "helper-not-started",
							error: message,
							helper
						});
						return;
					}
					writeJson(res, 202, {
						ok: true,
						accepted: true,
						instanceId,
						statusPath: restartStatusPath(),
						helper: {
							path: helperPath(),
							method: helper.method,
							pid: helper.pid
						},
						busy,
						forced: force,
						etaMs: 3e4
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await writeRestartPhase("failed", {
						error: message,
						hint: "无法启动重启助手；请手动重启 dsh web"
					});
					await clearInflight();
					writeJson(res, 500, {
						ok: false,
						code: "helper-failed",
						error: message
					});
					return;
				}
				setTimeout(() => {
					const recheck = busySnapshot(Date.now());
					if (!force && blocksOnBusy() && recheck.generating) {
						writeRestartPhase("aborted-busy", {
							busyAtHandoff: recheck,
							error: "检测到新开始的回答，已取消重启",
							hint: "回答结束后可再次点击重启"
						}).then(clearInflight);
						return;
					}
					setTimeout(() => requestExit(0), graceMs);
				}, RECHECK_DELAY_MS);
			}
		};
		const shutdownRoute = {
			kind: "exact",
			path: LAUNCHER_API.shutdown,
			handler: async (req, res) => {
				if (!guardPost(req, res)) return;
				const force = (await readJsonBody(req)).force === true;
				const busy = busySnapshot(Date.now());
				if (blocksOnBusy() && busy.generating && !force) {
					writeJson(res, 409, {
						ok: false,
						code: "busy",
						busy,
						hint: "有回答正在生成；等它结束后再退出，或用界面上的强制退出"
					});
					return;
				}
				writeJson(res, 200, { ok: true });
				setTimeout(() => requestExit(0), EXIT_DELAY_MS);
			}
		};
		disposers.push(ctx.webServer.register(pingRoute));
		disposers.push(ctx.webServer.register(statusRoute));
		disposers.push(ctx.webServer.register(logsRoute));
		disposers.push(ctx.webServer.register(logsClearRoute));
		disposers.push(ctx.webServer.register(logsOpenRoute));
		disposers.push(ctx.webServer.register(optionsRoute));
		disposers.push(ctx.webServer.register(createRoute));
		disposers.push(ctx.webServer.register(restartRoute));
		disposers.push(ctx.webServer.register(shutdownRoute));
		const value = current();
		if ((value.enabled ?? true) !== false && (value.announceToAgent ?? false) !== false) disposeSection = ctx.systemPrompt.section({
			name: "plugin:desktop-quick-launcher",
			order: SECTION_ORDER,
			text: DESKTOP_QUICK_LAUNCHER_GUIDANCE
		});
	};
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NAMESPACE, Config, config ?? {}, {
			setSource: (source) => {
				current = source;
				sync();
			},
			onChange: sync
		});
	});
	sync();
	(async () => {
		try {
			await refreshLauncherScript(launcherSpec);
		} catch {}
		try {
			const marker = await readInflight();
			if (marker !== null && marker.instanceId !== instanceId) await clearInflight();
		} catch {}
		await runCommand("schtasks", [
			"/delete",
			"/f",
			"/tn",
			restartTaskName()
		]);
	})();
}
//#endregion
export { Config, LAUNCHER_API, NONCE_HEADER, OPTION_FIELDS, PLUGIN_VERSION, apply, createDesktopShortcut, findOpenTurns, formatDuration, inject, isLauncherFailure, name, parseStatusFile, phaseSeverity, portFromUrl, refreshLauncherScript, renderLauncherScript, renderRestartHelper, renderScheduledTaskCommand, resolveLauncherSpec, stripBom, tailLines };
