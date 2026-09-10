/**
 * Unit tests for the generated launcher and restart helper.
 *
 * The generated PowerShell is not executed (that would start a real service);
 * instead the tests assert the contracts that matter and hand both scripts to
 * the real PowerShell parser, so a syntax error in the generated text fails CI
 * instead of failing on a user's desktop icon.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  portFromUrl,
  renderLauncherScript,
  renderRestartHelper,
  resolveLauncherSpec,
} from '../lib/index.mjs'

const LAUNCHER_SPEC = {
  dshCommand: 'dsh',
  url: 'http://127.0.0.1:3080',
  port: 3080,
  profile: 'web',
}

const RESTART_SPEC = {
  port: 3080,
  url: 'http://127.0.0.1:3080',
  hostPid: 4242,
  graceMs: 1500,
  dshCommand: 'dsh',
  profile: 'web',
  instanceIdBefore: 'instance-before-1234',
  waitSeconds: 150,
}

const LAUNCHER = renderLauncherScript('win32', LAUNCHER_SPEC)
const HELPER = renderRestartHelper(RESTART_SPEC)

test('portFromUrl derives the port, and falls back sensibly', () => {
  assert.equal(portFromUrl('http://127.0.0.1:3080'), 3080)
  assert.equal(portFromUrl('http://127.0.0.1'), 80)
  assert.equal(portFromUrl('https://example.test'), 443)
  assert.equal(portFromUrl('not a url'), 3080)
  assert.equal(portFromUrl('not a url', 9999), 9999)
})

test('resolveLauncherSpec keeps the live port and drops an empty profile', () => {
  const spec = resolveLauncherSpec({ url: 'http://127.0.0.1:4123', profile: '' })
  assert.equal(spec.port, 4123)
  assert.equal(spec.profile, undefined)
  const withProfile = resolveLauncherSpec({ url: 'http://127.0.0.1:4123', profile: 'web', port: 5555 })
  assert.equal(withProfile.profile, 'web')
  // The explicit (live webServer) port wins over the URL.
  assert.equal(withProfile.port, 5555)
})

test('win32 launcher carries the v0.2 probe, mutex, capture, and status contract', () => {
  assert.match(LAUNCHER, /System\.Threading\.Mutex/)
  assert.match(LAUNCHER, /Local\\DSH-Web-Launcher-/)
  assert.match(LAUNCHER, /Wait-ExistingInstance/)
  assert.match(LAUNCHER, /'dsh web authentication required'/)
  assert.match(LAUNCHER, /\/api\/dsh-desktop_quick_launcher\/ping/)
  assert.match(LAUNCHER, /-RedirectStandardOutput \$childOut -RedirectStandardError \$childErr/)
  assert.match(LAUNCHER, /Get-ChildTail 15/)
  assert.match(LAUNCHER, /UTF8Encoding\(\$false\)/)
  assert.match(LAUNCHER, /Move-Item -Force -LiteralPath \$temp/)
  assert.match(LAUNCHER, /'child-exit'/)
  assert.match(LAUNCHER, /'timeout-alive'/)
  assert.match(LAUNCHER, /'timeout-dead'/)
  assert.match(LAUNCHER, /'dsh-not-found'/)
  assert.match(LAUNCHER, /'up-unknown'/)
  assert.match(LAUNCHER, /'port-no-response'/)
  // The v0.1 "any 2xx-4xx counts as ready" probe must be gone.
  assert.doesNotMatch(LAUNCHER, /Test-DshUrl/)
  // UTF-8 BOM is added by the host when writing; the generator itself emits ASCII-safe text.
  assert.match(LAUNCHER, /^\uFEFF?# DSH web launcher/)
})

test('win32 launcher never kills processes (that is the helper\'s job)', () => {
  assert.doesNotMatch(LAUNCHER, /taskkill/)
})

test('restart helper bakes the handover values and drives the state machine', () => {
  assert.match(HELPER, /\$port = 3080/)
  assert.match(HELPER, /\$oldHostPid = 4242/)
  assert.match(HELPER, /\$graceMs = 1500/)
  assert.match(HELPER, /\$waitSeconds = 150/)
  assert.match(HELPER, /\$dshProfile = 'web'/)
  assert.match(HELPER, /\$instanceIdBefore = 'instance-before-1234'/)
  assert.match(HELPER, /'verifying-old'/)
  assert.match(HELPER, /'killing'/)
  assert.match(HELPER, /'spawning'/)
  assert.match(HELPER, /'ready'/)
  assert.match(HELPER, /'failed'/)
  assert.match(HELPER, /'timeout'/)
  assert.match(HELPER, /'aborted-busy'/)
  assert.match(HELPER, /Clear-Inflight/)
  assert.match(HELPER, /Get-AuthUrl/)
  assert.match(HELPER, /\^dsh web:/)
  // Readiness requires a DIFFERENT instanceId, not merely a 200.
  assert.match(HELPER, /\$probe\.instanceId -ne \$instanceIdBefore/)
})

test('restart helper never uses taskkill /T (it would kill itself)', () => {
  assert.doesNotMatch(HELPER, /taskkill\.exe[^\r\n]*\/T/)
  assert.match(HELPER, /taskkill\.exe \/PID \$child\.ProcessId \/F/)
  assert.match(HELPER, /taskkill\.exe \/PID \$oldHostPid \/F/)
  // The helper must skip itself when enumerating the old host's children.
  assert.match(HELPER, /if \(\[int\]\$child\.ProcessId -eq \$selfPid\) \{ continue \}/)
})

test('restart helper shares the probe and captures child output', () => {
  assert.match(HELPER, /function Get-Probe/)
  assert.match(HELPER, /function Test-TcpPort/)
  assert.match(HELPER, /function Get-PortOwner/)
  assert.match(HELPER, /-RedirectStandardOutput \$childOut -RedirectStandardError \$childErr/)
  assert.match(HELPER, /Get-ChildTail 15/)
})

test('the generated PowerShell parses', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ql-'))
  for (const [label, source] of [['launcher', LAUNCHER], ['helper', HELPER]]) {
    const file = join(dir, `${label}.ps1`)
    writeFileSync(file, '\uFEFF' + source, 'utf8')
    const escaped = file.replaceAll("'", "''")
    const command = [
      '$errors = $null',
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$errors)`,
      'if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
      "Write-Output 'OK'",
    ].join('; ')
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
      assert.match(output, /OK/, `${label} parse produced no OK`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      assert.fail(`${label}.ps1 failed to parse: ${detail}`)
    }
  }
})

test('POSIX launcher stays a bash script with the platform opener', () => {
  const linux = renderLauncherScript('linux', LAUNCHER_SPEC)
  assert.match(linux, /^#!\/bin\/bash/)
  assert.match(linux, /xdg-open "\$URL"/)
  const mac = renderLauncherScript('darwin', LAUNCHER_SPEC)
  assert.match(mac, /open "\$URL"/)
})
