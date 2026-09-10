/**
 * Host-half integration tests: mount the real plugin with a stub cordis context
 * and drive the real route handlers over fake HTTP objects.
 *
 * What this covers without starting a service: the loopback fence, the nonce
 * gate, the busy gate for both restart and shutdown, the inflight gate, the
 * restart handover (202 + status file + helper script + marker), and the
 * pre-exit busy re-check that cancels a restart.
 *
 * The survivor spawn and the process exit are injected (ApplyHooks), so a test
 * run never spawns a helper and never exits the runner. DSH_HOME is redirected
 * to a temp directory, so nothing under the user's real ~/.dsh is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAUNCHER_API, NONCE_HEADER, apply } from '../lib/index.mjs'

const BASE_CONFIG = {
  dshCommand: 'dsh',
  url: 'http://127.0.0.1:3080',
  restartGraceMs: 200,
  restartTimeoutSec: 30,
  helperStartTimeoutMs: 400,
}

/** A session with an unfinished turn, shaped like the real Session. */
function generatingSession(id = 'session-1', turn = 3) {
  return {
    id,
    snapshotEvents: () => [{ type: 'turn/start', time: new Date().toISOString(), data: { turn } }],
  }
}

/**
 * Mount the plugin against a stub context.
 * @returns the captured routes plus the recorded spawns/exits.
 */
function harness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ql-home-'))
  process.env.DSH_HOME = home

  const routes = new Map()
  const spawns = []
  const exits = []
  const handoffWrites = []
  let sessions = options.sessions

  const ctx = {
    webServer: {
      port: options.port ?? 3080,
      register(route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    systemPrompt: { section: () => () => {} },
    get(name) {
      if (name === 'sessions') return sessions
      return undefined
    },
    inject() { /* settings wiring is not needed for these tests */ },
  }

  apply(ctx, { ...BASE_CONFIG, ...(options.config ?? {}) }, {
    spawnSurvivor: options.spawnSurvivor ?? (async (helperPath) => {
      spawns.push(helperPath)
      const statusPath = join(home, 'desktop-quick-launcher', 'restart-status.json')
      // Record what the host wrote before the helper touches it.
      handoffWrites.push(JSON.parse(readFileSync(statusPath, 'utf8')))
      // Mimic the real helper's first action: move the shared file past
      // `handoff`, which is what the host's start-gate waits for.
      const state = JSON.parse(readFileSync(statusPath, 'utf8'))
      state.phase = 'verifying-old'
      state.updatedAt = new Date().toISOString()
      writeFileSync(statusPath, JSON.stringify(state, null, 2))
      return { pid: 4321, method: 'detached' }
    }),
    requestExit: (code) => { exits.push(code) },
  })

  return {
    home,
    routes,
    spawns,
    exits,
    handoffWrites,
    scriptsDir: join(home, 'desktop-quick-launcher'),
    setSessions(next) { sessions = next },
    nonce: options.nonce,
    async call(path, { method = 'GET', headers = {}, body = null, remote = '127.0.0.1', query = '' } = {}) {
      const route = routes.get(path)
      assert.ok(route, `route not registered: ${path}`)
      const req = new Readable({ read() {} })
      req.method = method
      req.headers = { host: '127.0.0.1:3080', ...headers }
      req.socket = { remoteAddress: remote }
      req.url = query === '' ? path : `${path}?${query}`
      if (body !== null) req.push(body)
      req.push(null)
      const res = {
        status: 0,
        headers: null,
        body: '',
        writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
        end(chunk) { if (chunk !== undefined && chunk !== null) this.body += String(chunk) },
      }
      await route.handler(req, res)
      let json = null
      try { json = JSON.parse(res.body) } catch { /* non-JSON responses keep json = null */ }
      return { status: res.status, json, raw: res.body }
    },
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

test('ping serves identity and the nonce to loopback callers without credentials', async () => {
  const app = harness({ nonce: undefined })
  const result = await app.call(LAUNCHER_API.ping)
  assert.equal(result.status, 200)
  assert.equal(result.json.plugin, 'dsh-desktop_quick_launcher')
  assert.equal(result.json.port, 3080)
  assert.equal(result.json.pid, process.pid)
  assert.match(result.json.instanceId, /^[0-9a-f-]{36}$/)
  assert.match(result.json.nonce, /^[0-9a-f-]{36}$/)
})

test('the loopback fence rejects cross-site and non-loopback callers', async () => {
  const app = harness({})
  const crossSite = await app.call(LAUNCHER_API.ping, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const foreignOrigin = await app.call(LAUNCHER_API.ping, { headers: { origin: 'http://evil.test' } })
  assert.equal(foreignOrigin.status, 403)
  const remote = await app.call(LAUNCHER_API.ping, { remote: '10.0.0.7' })
  assert.equal(remote.status, 403)
  const badHost = await app.call(LAUNCHER_API.ping, { headers: { host: 'evil.test:3080' } })
  assert.equal(badHost.status, 403)
})

test('status reports busy as unknown (fail-open) when there is no sessions service', async () => {
  const app = harness({ sessions: undefined })
  const result = await app.call(LAUNCHER_API.status)
  assert.equal(result.status, 200)
  assert.equal(result.json.busy.known, false)
  assert.equal(result.json.busy.generating, false)
  assert.match(result.json.busy.check, /unavailable/)
  assert.equal(result.json.port.isSelf, true)
  assert.equal(result.json.launcher.report, null)
  assert.equal(result.json.restart.inflight, null)
  assert.match(result.json.logs.dir, /desktop-quick-launcher$/)
  // The settings card drives these through the host config echo.
  assert.equal(result.json.config.showDetailsButton, true)
  assert.equal(result.json.config.showStopButton, true)
  assert.equal(result.json.config.showRestartButton, true)
  assert.equal(result.json.config.helperStartTimeoutMs, 400)
})

test('floating-button flags follow the config', async () => {
  const app = harness({
    sessions: { list: () => [] },
    config: { showDetailsButton: false, showRestartButton: false },
  })
  const result = await app.call(LAUNCHER_API.status)
  assert.equal(result.json.config.showDetailsButton, false)
  assert.equal(result.json.config.showStopButton, true)
  assert.equal(result.json.config.showRestartButton, false)
})

test('the log list covers the plugin directory and never leaves it', async () => {
  const app = harness({ sessions: { list: () => [] } })
  const empty = await app.call(LAUNCHER_API.logs)
  assert.equal(empty.status, 200)
  assert.equal(empty.json.dir, app.scriptsDir)
  assert.equal(empty.json.files.length, 7)
  assert.ok(empty.json.files.every(file => file.exists === false))

  // A real launcher.log appears once the (regenerated) launcher has run.
  mkdirSync(app.scriptsDir, { recursive: true })
  writeFileSync(join(app.scriptsDir, 'launcher.log'), 'one\ntwo\nthree\n', 'utf8')
  const listed = await app.call(LAUNCHER_API.logs)
  const launcher = listed.json.files.find(file => file.name === 'launcher')
  assert.equal(launcher.exists, true)
  assert.equal(launcher.size, 14)

  const content = await app.call(LAUNCHER_API.logs, { query: 'name=launcher&tail=2' })
  assert.equal(content.status, 200)
  assert.equal(content.json.text, 'two\nthree')

  const missing = await app.call(LAUNCHER_API.logs, { query: 'name=childErr' })
  assert.equal(missing.status, 200)
  assert.equal(missing.json.text, '')

  // The name is a whitelist key, never a path.
  for (const attack of ['../../etc/passwd', 'C:\\Windows\\win.ini', 'launcher.log', '']) {
    const res = await app.call(LAUNCHER_API.logs, { query: `name=${encodeURIComponent(attack)}` })
    assert.equal(res.status, 404, `path traversal must be rejected: ${attack}`)
  }
})

test('clearing logs truncates logs and deletes status files, and needs the nonce', async () => {
  const app = harness({ sessions: { list: () => [] } })
  mkdirSync(app.scriptsDir, { recursive: true })
  writeFileSync(join(app.scriptsDir, 'launcher.log'), 'keep me not', 'utf8')
  writeFileSync(join(app.scriptsDir, 'launcher-status.json'), '{"schema":1}', 'utf8')

  const refused = await app.call(LAUNCHER_API.logsClear, { method: 'POST', body: '{}' })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.code, 'nonce-required')

  const ping = await app.call(LAUNCHER_API.ping)
  const cleared = await app.call(LAUNCHER_API.logsClear, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({ names: ['launcher', 'launcherStatus'] }),
  })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.json.cleared, ['launcher', 'launcherStatus'])
  assert.equal(readFileSync(join(app.scriptsDir, 'launcher.log'), 'utf8'), '')
  assert.equal(existsSync(join(app.scriptsDir, 'launcher-status.json')), false)

  // An unknown name is ignored rather than failing the batch.
  const ignored = await app.call(LAUNCHER_API.logsClear, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({ names: ['../evil'] }),
  })
  assert.equal(ignored.status, 200)
  assert.deepEqual(ignored.json.cleared, [])
})

test('the open-folder route is gated by the nonce', async () => {
  const app = harness({ sessions: { list: () => [] } })
  const refused = await app.call(LAUNCHER_API.logsOpen, { method: 'POST', body: '{}' })
  assert.equal(refused.status, 403)
  const wrongMethod = await app.call(LAUNCHER_API.logsOpen)
  assert.equal(wrongMethod.status, 405)
  // The success path would open a real file manager, so it is not exercised here.
})

test('status reports the generating sessions from the session store', async () => {
  const app = harness({ sessions: { list: () => [generatingSession('session-9', 4)] } })
  const result = await app.call(LAUNCHER_API.status)
  assert.equal(result.json.busy.known, true)
  assert.equal(result.json.busy.generating, true)
  assert.equal(result.json.busy.openTurns[0].sessionId, 'session-9')
  assert.equal(result.json.busy.openTurns[0].turn, 4)
})

test('state-changing routes require the nonce and a POST', async () => {
  const app = harness({})
  const ping = await app.call(LAUNCHER_API.ping)
  const nonce = ping.json.nonce

  const noNonce = await app.call(LAUNCHER_API.create, { method: 'POST', body: '{}' })
  assert.equal(noNonce.status, 403)
  assert.equal(noNonce.json.code, 'nonce-required')

  const wrongNonce = await app.call(LAUNCHER_API.create, {
    method: 'POST',
    headers: { [NONCE_HEADER]: 'not-the-nonce' },
    body: '{}',
  })
  assert.equal(wrongNonce.status, 403)

  const getInstead = await app.call(LAUNCHER_API.restart, { headers: { [NONCE_HEADER]: nonce } })
  assert.equal(getInstead.status, 405)

  // Nothing may have been written by the refused calls.
  assert.equal(existsSync(join(app.scriptsDir, 'launcher.ps1')), false)
  assert.equal(existsSync(join(app.scriptsDir, 'restart-helper.ps1')), false)
})

test('restart is refused with 409 while an answer is being generated', async () => {
  const app = harness({ sessions: { list: () => [generatingSession()] } })
  const nonce = (await app.call(LAUNCHER_API.ping)).json.nonce
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'busy')
  assert.equal(result.json.busy.generating, true)
  // A refused restart must not hand over at all.
  assert.equal(app.spawns.length, 0)
  assert.equal(existsSync(join(app.scriptsDir, 'restart-helper.ps1')), false)
  assert.equal(existsSync(join(app.scriptsDir, 'restart-status.json')), false)
})

test('shutdown is refused with 409 while an answer is being generated', async () => {
  const app = harness({ sessions: { list: () => [generatingSession()] } })
  const nonce = (await app.call(LAUNCHER_API.ping)).json.nonce
  const result = await app.call(LAUNCHER_API.shutdown, {
    method: 'POST',
    headers: { [NONCE_HEADER]: nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'busy')
  await sleep(700)
  assert.deepEqual(app.exits, [])
})

test('restart is refused while another restart is in flight', async () => {
  const app = harness({ sessions: { list: () => [] } })
  // Let the boot-time housekeeping settle before planting the marker, so it
  // cannot be mistaken for a previous instance's leftover.
  await sleep(200)
  const ping = await app.call(LAUNCHER_API.ping)
  const fs = await import('node:fs')
  fs.mkdirSync(app.scriptsDir, { recursive: true })
  fs.writeFileSync(join(app.scriptsDir, 'restart-inflight.json'), JSON.stringify({
    instanceId: ping.json.instanceId,
    helperPid: 999,
    at: new Date().toISOString(),
    ttlMs: 90_000,
  }))
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'restart-inflight')
  assert.equal(app.spawns.length, 0)
})

test('an idle restart hands over: 202, status file, helper script, marker, then exit', async () => {
  const app = harness({ sessions: { list: () => [] } })
  const ping = await app.call(LAUNCHER_API.ping)
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })

  assert.equal(result.status, 202)
  assert.equal(result.json.accepted, true)
  assert.equal(result.json.instanceId, ping.json.instanceId)
  assert.equal(result.json.helper.method, 'detached')
  assert.equal(result.json.forced, false)
  assert.equal(app.spawns.length, 1)

  const helper = readFileSync(result.json.helper.path, 'utf8')
  assert.match(helper, /^\uFEFF# DSH web restart helper/)
  assert.match(helper, new RegExp(ping.json.instanceId))
  assert.doesNotMatch(helper, /taskkill\.exe[^\r\n]*\/T/)

  const handoff = app.handoffWrites[0]
  assert.equal(handoff.phase, 'handoff')
  assert.equal(handoff.instanceIdBefore, ping.json.instanceId)
  assert.equal(handoff.hostPid, process.pid)
  assert.equal(handoff.forced, false)
  assert.equal(handoff.busyAtHandoff.generating, false)
  // The (simulated) helper moved the shared file past `handoff`, which is the
  // proof the host's start-gate waits for before it dares to exit.
  assert.equal(JSON.parse(readFileSync(join(app.scriptsDir, 'restart-status.json'), 'utf8')).phase, 'verifying-old')

  const marker = JSON.parse(readFileSync(join(app.scriptsDir, 'restart-inflight.json'), 'utf8'))
  assert.equal(marker.instanceId, ping.json.instanceId)
  assert.equal(marker.helperPid, 4321)

  // The pre-exit re-check runs first; idle means the host really exits.
  await sleep(1600)
  assert.deepEqual(app.exits, [0])
})

test('a turn starting during the grace window cancels the restart', async () => {
  let generating = false
  const app = harness({ sessions: { list: () => (generating ? [generatingSession()] : []) } })
  const ping = await app.call(LAUNCHER_API.ping)
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 202)

  // A new answer starts right after the handover.
  generating = true
  await sleep(1600)

  assert.deepEqual(app.exits, [], 'the host must NOT exit once a turn is open')
  const status = JSON.parse(readFileSync(join(app.scriptsDir, 'restart-status.json'), 'utf8'))
  assert.equal(status.phase, 'aborted-busy')
  assert.equal(status.busyAtHandoff.generating, true)
  // The cancellation also releases the inflight gate for a later retry.
  assert.equal(existsSync(join(app.scriptsDir, 'restart-inflight.json')), false)
})

test('forced restart skips the busy gate and records the override', async () => {
  const app = harness({ sessions: { list: () => [generatingSession()] } })
  const ping = await app.call(LAUNCHER_API.ping)
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({ force: true }),
  })
  assert.equal(result.status, 202)
  assert.equal(result.json.forced, true)
  assert.equal(app.handoffWrites[0].forced, true)
  await sleep(1500)
  // Forced restarts go straight through the re-check.
  assert.deepEqual(app.exits, [0])
})

test('busyPolicy warn downgrades the gate to a report', async () => {
  const app = harness({
    sessions: { list: () => [generatingSession()] },
    config: { busyPolicy: 'warn' },
  })
  const ping = await app.call(LAUNCHER_API.ping)
  const status = await app.call(LAUNCHER_API.status)
  assert.equal(status.json.busy.generating, true)
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 202)
  await sleep(1500)
  assert.deepEqual(app.exits, [0])
})

test('a helper that never starts cancels the restart and keeps the service alive', async () => {
  // Exactly the failure that motivated the start-gate: the survivor mechanism
  // produced no worker (the detached child was killed with the host's process
  // tree), the host exited anyway, and the user was left with a dead service.
  const app = harness({
    sessions: { list: () => [] },
    spawnSurvivor: async () => ({ pid: 777, method: 'detached' }),
  })
  const ping = await app.call(LAUNCHER_API.ping)
  const result = await app.call(LAUNCHER_API.restart, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })

  assert.equal(result.status, 500)
  assert.equal(result.json.code, 'helper-not-started')
  assert.deepEqual(app.exits, [], 'the host must stay alive when the helper never starts')
  const status = JSON.parse(readFileSync(join(app.scriptsDir, 'restart-status.json'), 'utf8'))
  assert.equal(status.phase, 'failed')
  assert.match(status.error, /未开始工作/)
  // The gate also releases the inflight marker so the user can retry at once.
  assert.equal(existsSync(join(app.scriptsDir, 'restart-inflight.json')), false)
})

test('an idle shutdown acknowledges then exits', async () => {
  const app = harness({ sessions: { list: () => [] } })
  const ping = await app.call(LAUNCHER_API.ping)
  const result = await app.call(LAUNCHER_API.shutdown, {
    method: 'POST',
    headers: { [NONCE_HEADER]: ping.json.nonce },
    body: JSON.stringify({}),
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  await sleep(900)
  assert.deepEqual(app.exits, [0])
})
