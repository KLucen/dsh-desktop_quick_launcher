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

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from 'schemastery'
import {
  DEFAULT_DSH_COMMAND,
  DEFAULT_GRACE_MS,
  DEFAULT_URL,
  DEFAULT_WAIT_SECONDS,
  LAUNCHER_FILES,
  PLUGIN_ROUTE_PREFIX,
  desktopFileName,
  portFromUrl,
  renderDesktopEntry,
  renderLauncherScript,
  renderRestartHelper,
  renderShortcutInstaller,
  resolveLauncherSpec,
  scriptFileName,
  type LauncherPlatform,
  type LauncherSpec,
  type RestartSpec,
} from './core/launcher'
import { findOpenTurns, type SessionEventLike, type SessionView } from './core/busy'
import {
  parseStatusFile,
  stripBom,
  type BusySnapshot,
  type StatusFile,
} from './core/status'

// ---------------------------------------------------------------------------
// re-exports: keep the pure helpers reachable for tooling and the test suite
// ---------------------------------------------------------------------------

export { renderLauncherScript, renderRestartHelper, resolveLauncherSpec, portFromUrl } from './core/launcher'
export { findOpenTurns } from './core/busy'
export {
  formatDuration,
  isLauncherFailure,
  parseStatusFile,
  phaseSeverity,
  stripBom,
  tailLines,
} from './core/status'
export type { LauncherPlatform, LauncherSpec, RestartSpec } from './core/launcher'
export type { OpenTurn, SessionEventLike, SessionView } from './core/busy'
export type {
  BusySnapshot,
  ChildInfo,
  KilledProcess,
  LauncherPhase,
  LauncherStatus,
  MutexInfo,
  PortOwnerInfo,
  ProbeClass,
  ProbeInfo,
  RestartPhase,
  RestartStatus,
  StatusFile,
} from './core/status'

const execFileAsync = promisify(execFile)

/** Stable cordis plugin name. */
export const name = 'dsh-desktop_quick_launcher'

/** Host services this plugin consumes. `sessions` is read optionally at runtime. */
export const inject = ['webServer', 'systemPrompt']

/** Wire contract between host routes and the browser API helpers. */
export const LAUNCHER_API = {
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
} as const

/** Nonce header required by every state-changing route. */
export const NONCE_HEADER = 'x-dsh-ql-nonce'

/** Plugin version, mirrored from package.json by hand. */
export const PLUGIN_VERSION = '0.2.0'

/** How long a restart handover marker blocks a second restart. */
const INFLIGHT_TTL_MS = 90_000

/** Delay between the 202 acknowledgement and the pre-exit busy re-check. */
const RECHECK_DELAY_MS = 1_000

/** How long the exit request waits after the response is flushed. */
const EXIT_DELAY_MS = 500

/** Result of a desktop-icon creation. */
export interface CreateResult {
  ok: true
  /** Absolute path of the icon on the Desktop. */
  path: string
  /** Platform the icon was generated for. */
  platform: LauncherPlatform
  /** Non-fatal notice (e.g. dsh missing from PATH). */
  warning?: string
}

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the model-facing guidance section. */
  enabled?: boolean
  /** When true, a system-prompt section announces the plugin to the agent. */
  announceToAgent?: boolean
  /** Command that starts dsh (must be on PATH when the launcher runs). */
  dshCommand?: string
  /** Base URL of the dsh web GUI. */
  url?: string
  /** Optional profile started as `dsh --profile <profile> --no-open`. */
  profile?: string
  /** Optional icon file (.ico/.png) for the desktop icon; empty uses the bundled dsh icon. */
  iconPath?: string
  /** Whether the shutdown control asks for confirmation before exiting. */
  confirmShutdown?: boolean
  /** Grace period between the restart acknowledgement and the host exiting. */
  restartGraceMs?: number
  /** Readiness budget for the restart helper, in seconds. */
  restartTimeoutSec?: number
  /**
   * `block` (default) refuses a restart while a turn is open. `warn` only
   * reports it.
   */
  busyPolicy?: string
  /**
   * Survivor mechanism: `auto` tries a detached child first and falls back to
   * schtasks, `schtasks` always uses a scheduled task.
   */
  restartMethod?: string
  /** Show the last launcher report as a banner when the GUI loads. */
  showLaunchReport?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
  dshCommand: z.string().default(DEFAULT_DSH_COMMAND),
  url: z.string().default(DEFAULT_URL),
  profile: z.string().default(''),
  iconPath: z.string().default(''),
  confirmShutdown: z.boolean().default(true),
  restartGraceMs: z.natural().default(DEFAULT_GRACE_MS),
  restartTimeoutSec: z.natural().default(DEFAULT_WAIT_SECONDS),
  busyPolicy: z.string().default('block'),
  restartMethod: z.string().default('auto'),
  showLaunchReport: z.boolean().default(true),
})

/** Settings namespace owned by this plugin (host + browser spell the same value). */
const NAMESPACE = 'desktop-quick-launcher'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

const DESKTOP_QUICK_LAUNCHER_GUIDANCE =
  '本机已安装 desktop-quick-launcher 插件（DSH 桌面快捷启动 + 一键重启/退出）：' +
  '「设置 → 插件配置」可配置 dshCommand / url / profile；界面右下角悬浮面板可「生成/刷新桌面图标」' +
  '（Windows .lnk 双击即启动 dsh web 并打开浏览器）、「重启服务」（宿主优雅退出后由独立助手拉起新实例，' +
  '页面自动回到原会话）、「停止 DSH 服务」（确认后请求宿主进程优雅退出）。' +
  '安全与限制：图标创建、重启、退出接口均仅限本机回环访问且需要一次性 nonce；' +
  '只要有回答正在生成（session 存在未结束的回合），重启与退出会被拒绝（返回 409），' +
  '必须先等回答结束或在界面里选择「等空闲后自动重启」。' +
  '用户提到「桌面图标 / 快捷方式 / 一键启动 / 重启 DSH / 退出 DSH」时即指本插件。'

/** The dsh launcher provides ctx.appExit via @deepseek-ai/dsh-cmdline. Spelled locally. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Bounded process-exit request provided by the dsh launcher. */
    appExit?: (code: number) => void
  }
}

// ---------------------------------------------------------------------------
// shared host helpers (migrated from the retired plugin family)
// ---------------------------------------------------------------------------

function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Loopback trust fence: socket address AND Host header AND same-origin markers. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress
  if (remote === undefined) return false
  const address = remote.toLowerCase()
  const loopbackSocket = address === '::1'
    || (address.startsWith('::ffff:') && isIPv4Loopback(address.slice('::ffff:'.length)))
    || isIPv4Loopback(address)
  if (!loopbackSocket) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Resolve $DSH_HOME with a ~/.dsh fallback. */
function dshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = raw.trim().startsWith('~')
      ? join(home, raw.trim().slice(1).replace(/^[\\/]/, ''))
      : raw.trim()
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** Run a command, capturing exit code and stderr (30 s cap). */
async function runCommand(file: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  try {
    await execFileAsync(file, args, { timeout: 30_000, windowsHide: true })
    return { code: 0, stderr: '' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : null
    return {
      code: typeof code === 'number' ? code : null,
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read a JSON request body; never throws, never blocks the response. */
async function readJsonBody(request: IncomingMessage, limitBytes = 4096): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        resolve({})
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {})
      } catch {
        resolve({})
      }
    })
    request.on('error', () => { resolve({}) })
  })
}

/** Clamp a possibly-absent numeric body field. */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

// ---------------------------------------------------------------------------
// icon creation
// ---------------------------------------------------------------------------

/** The dsh icon bundled with the package (assets/ next to lib/). */
let bundledIconPath: string | undefined
let bundledPngPath: string | undefined
if (import.meta.url.startsWith('file:')) {
  try { bundledIconPath = fileURLToPath(new URL('../assets/dsh.ico', import.meta.url)) } catch { /* tolerate */ }
  try { bundledPngPath = fileURLToPath(new URL('../assets/dsh.png', import.meta.url)) } catch { /* tolerate */ }
}

function resolveIconSource(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured !== '' && existsSync(configured)) return configured
  return bundledIconPath !== undefined && existsSync(bundledIconPath) ? bundledIconPath : undefined
}

function toLauncherPlatform(platform: string): LauncherPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  throw new Error(`unsupported platform: ${platform}`)
}

/** Desktop directory with the Windows OneDrive redirect fallback. */
function resolveDesktopDir(home: string, platform: LauncherPlatform): string {
  const desktop = join(home, 'Desktop')
  if (platform === 'win32' && !existsSync(desktop)) {
    const onedrive = join(home, 'OneDrive', 'Desktop')
    if (existsSync(onedrive)) return onedrive
  }
  return desktop
}

/** Best-effort dsh probe on PATH (never throws). */
async function probeDsh(platform: LauncherPlatform, dshCommand: string): Promise<boolean> {
  if (isAbsolute(dshCommand) || dshCommand.includes('/') || dshCommand.includes('\\')) {
    return existsSync(dshCommand)
  }
  try {
    const result = platform === 'win32'
      ? await runCommand('where', [dshCommand])
      : await runCommand('sh', ['-lc', 'command -v -- "$1"', 'desktop-quick-launcher', dshCommand])
    return result.code === 0
  } catch {
    return false
  }
}

/** Write the launcher script + place the desktop icon for the current platform. */
export async function createDesktopShortcut(specSource: () => LauncherSpec): Promise<CreateResult> {
  const spec = specSource()
  const platform = toLauncherPlatform(process.platform)
  const home = homedir()
  const scriptsDir = join(dshHome(), 'desktop-quick-launcher')
  await mkdir(scriptsDir, { recursive: true })
  const launcherPath = join(scriptsDir, scriptFileName(platform))
  // UTF-8 BOM: Windows PowerShell 5.1 misreads non-ASCII bodies without it.
  await writeFile(launcherPath, '\uFEFF' + renderLauncherScript(platform, spec), { mode: 0o755 })

  let iconIco: string | undefined
  let iconPng: string | undefined
  const iconSource = resolveIconSource(spec.iconPath)
  if (iconSource !== undefined) {
    iconIco = join(scriptsDir, LAUNCHER_FILES.icon)
    await copyFile(iconSource, iconIco)
    if (/\.png$/i.test(iconSource)) {
      iconPng = join(scriptsDir, LAUNCHER_FILES.iconPng)
      await copyFile(iconSource, iconPng)
    } else if (bundledPngPath !== undefined && existsSync(bundledPngPath)) {
      iconPng = join(scriptsDir, LAUNCHER_FILES.iconPng)
      await copyFile(bundledPngPath, iconPng)
    }
  }

  const desktopDir = resolveDesktopDir(home, platform)
  await mkdir(desktopDir, { recursive: true })
  const iconPath = join(desktopDir, desktopFileName(platform))
  let warning: string | undefined
  const dshFound = await probeDsh(platform, spec.dshCommand)
  if (!dshFound) warning = `dsh command "${spec.dshCommand}" was not found on PATH; the launcher shows a message when run`

  if (platform === 'win32') {
    const installerPath = join(scriptsDir, LAUNCHER_FILES.shortcutInstaller)
    await writeFile(installerPath, '\uFEFF' + renderShortcutInstaller({
      launcherPath,
      desktopPath: iconPath,
      workingDirectory: scriptsDir,
      iconLocation: iconIco ?? 'powershell.exe,0',
    }))
    const result = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath])
    if (result.code !== 0) throw new Error(`shortcut creation failed: ${result.stderr}`)
  } else if (platform === 'darwin') {
    await writeFile(iconPath, renderLauncherScript(platform, spec), { mode: 0o755 })
  } else {
    await writeFile(iconPath, renderDesktopEntry(launcherPath, iconPng ?? iconIco), { mode: 0o755 })
    await chmod(launcherPath, 0o755)
    const trust = await runCommand('gio', ['set', iconPath, 'metadata::trusted', 'true'])
    if (trust.code !== 0) warning = `desktop entry created but not marked trusted: ${trust.stderr}`
  }
  return { ok: true, path: iconPath, platform, ...(warning === undefined ? {} : { warning }) }
}

// ---------------------------------------------------------------------------
// plugin apply
// ---------------------------------------------------------------------------

/** Structural view of the session store we read for the busy check. */
interface SessionStoreLike {
  list(): unknown[]
}

/** A restart handover marker. */
interface InflightMarker {
  instanceId: string
  helperPid: number
  at: string
  ttlMs: number
}

/** What a status file read produced. */
interface StatusRead {
  report: StatusFile | null
  ageMs: number | null
  readError: string | null
}

/**
 * Optional dependency injection for `apply`.
 *
 * Production never passes these. The test suite uses them to exercise the
 * restart handover (202 body, status file, helper script, inflight marker, and
 * the pre-exit busy re-check) without spawning a real helper or exiting the test
 * runner.
 */
export interface ApplyHooks {
  /** Replace the survivor spawn. */
  spawnSurvivor?: (helperPath: string) => Promise<{ pid: number; method: 'detached' | 'schtasks' }>
  /** Replace the exit request. */
  requestExit?: (code: number) => void
}

/**
 * Mount the routes, the settings section, and the (optional) system-prompt
 * section.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config.
 * @param hooks - test-only overrides for the spawn/exit side effects.
 */
export function apply(ctx: Context, config?: Config, hooks?: ApplyHooks): void {
  let current: () => Config = () => config ?? {}
  const disposers: (() => void)[] = []
  let disposeSection: (() => void) | undefined

  /** Identity of THIS process; a changed instanceId is the readiness proof. */
  const instanceId = randomUUID()
  /** One-time token every state-changing route requires. */
  const nonce = randomUUID()
  const startedAt = Date.now()

  let exitRequested = false
  const requestExit = (code: number): void => {
    if (exitRequested) return
    exitRequested = true
    if (hooks?.requestExit !== undefined) {
      hooks.requestExit(code)
      return
    }
    const exit = ctx.get('appExit')
    if (exit !== undefined) {
      exit(code)
      return
    }
    process.exit(code)
  }

  const scriptsDir = (): string => join(dshHome(), 'desktop-quick-launcher')
  const pathIn = (file: string): string => join(scriptsDir(), file)
  const launcherStatusPath = (): string => pathIn(LAUNCHER_FILES.launcherStatus)
  const restartStatusPath = (): string => pathIn(LAUNCHER_FILES.restartStatus)
  const inflightPath = (): string => pathIn(LAUNCHER_FILES.restartInflight)
  const helperPath = (): string => pathIn(LAUNCHER_FILES.restartHelper)

  /** Real listening port, falling back to the configured URL. */
  const resolvedPort = (): number => {
    try {
      const port = ctx.webServer.port
      if (typeof port === 'number' && Number.isInteger(port) && port > 0) return port
    } catch { /* not listening yet */ }
    return portFromUrl(current().url ?? DEFAULT_URL)
  }

  /** Config plus the live port, as the launcher/helper generators need it. */
  const launcherSpec = (): LauncherSpec => resolveLauncherSpec({ ...current(), port: resolvedPort() })

  const restartSpec = (graceMs: number): RestartSpec => {
    const value = current()
    return {
      port: resolvedPort(),
      url: value.url ?? DEFAULT_URL,
      hostPid: process.pid,
      graceMs,
      dshCommand: value.dshCommand ?? DEFAULT_DSH_COMMAND,
      ...(value.profile === undefined || value.profile === '' ? {} : { profile: value.profile }),
      instanceIdBefore: instanceId,
      waitSeconds: value.restartTimeoutSec ?? DEFAULT_WAIT_SECONDS,
    }
  }

  /**
   * Is an answer being generated right now?
   *
   * Fails OPEN (`known:false`) when the sessions service is unreachable or its
   * API changed: a fail-closed check would disable restart forever, which is a
   * worse failure than a missed interruption. The reason is recorded and shown.
   */
  const busySnapshot = (now: number): BusySnapshot => {
    const checkedAt = new Date(now).toISOString()
    let store: SessionStoreLike | undefined
    try {
      store = ctx.get('sessions') as SessionStoreLike | undefined
    } catch {
      store = undefined
    }
    if (store === undefined || typeof store.list !== 'function') {
      return { known: false, check: 'unavailable: sessions service not present', generating: false, openTurns: [], checkedAt }
    }
    try {
      const views: SessionView[] = []
      for (const raw of store.list()) {
        const session = raw as { id?: unknown; snapshotEvents?: unknown }
        if (typeof session.id !== 'string' || typeof session.snapshotEvents !== 'function') continue
        const events = (session.snapshotEvents as () => readonly SessionEventLike[])()
        views.push({ id: session.id, events: Array.isArray(events) ? events : [] })
      }
      const openTurns = findOpenTurns(views, now)
      return { known: true, check: 'sessions', generating: openTurns.length > 0, openTurns, checkedAt }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { known: false, check: `unavailable: ${reason}`, generating: false, openTurns: [], checkedAt }
    }
  }

  /** Blocking mode, unless the operator asked for warnings only. */
  const blocksOnBusy = (): boolean => (current().busyPolicy ?? 'block') !== 'warn'

  const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await rename(temp, path)
  }

  const readStatusFile = async (path: string): Promise<StatusRead> => {
    try {
      const parsed = parseStatusFile(await readFile(path, 'utf8'))
      if (!parsed.ok) return { report: null, ageMs: null, readError: parsed.error }
      const updated = Date.parse((parsed.value as { updatedAt: string }).updatedAt)
      return {
        report: parsed.value,
        ageMs: Number.isNaN(updated) ? null : Math.max(0, Date.now() - updated),
        readError: null,
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') return { report: null, ageMs: null, readError: null }
      return { report: null, ageMs: null, readError: error instanceof Error ? error.message : String(error) }
    }
  }

  const readInflight = async (): Promise<InflightMarker | null> => {
    try {
      const raw = JSON.parse(stripBom(await readFile(inflightPath(), 'utf8'))) as Record<string, unknown>
      const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
      const ttlMs = typeof raw.ttlMs === 'number' ? raw.ttlMs : INFLIGHT_TTL_MS
      if (Number.isNaN(at) || Date.now() - at >= ttlMs) return null
      return {
        instanceId: typeof raw.instanceId === 'string' ? raw.instanceId : '',
        helperPid: typeof raw.helperPid === 'number' ? raw.helperPid : 0,
        at: typeof raw.at === 'string' ? raw.at : '',
        ttlMs,
      }
    } catch {
      return null
    }
  }

  const clearInflight = async (): Promise<void> => {
    try { await rm(inflightPath(), { force: true }) } catch { /* already gone */ }
  }

  /** Merge one phase update into restart-status.json. */
  const writeRestartPhase = async (phase: string, extra: Record<string, unknown>): Promise<void> => {
    try {
      let base: Record<string, unknown> = {}
      try {
        base = JSON.parse(stripBom(await readFile(restartStatusPath(), 'utf8'))) as Record<string, unknown>
      } catch { /* write a fresh object */ }
      await writeJsonFile(restartStatusPath(), {
        ...base,
        schema: 1,
        updatedAt: new Date().toISOString(),
        phase,
        ...extra,
      })
    } catch { /* the helper owns the file if the host is gone */ }
  }

  /**
   * Spawn the restart helper so that it outlives this process.
   *
   * L1 is a detached child (its own process group); L2 is a scheduled task,
   * which is parented by the Task Scheduler service and therefore immune to the
   * old host's process-tree cleanup. `restartMethod` can pin either one.
   */
  const spawnSurvivor = async (file: string): Promise<{ pid: number; method: 'detached' | 'schtasks' }> => {
    if (hooks?.spawnSurvivor !== undefined) return await hooks.spawnSurvivor(file)
    return await defaultSpawnSurvivor(file)
  }

  /** The production survivor ladder (L1 detached, L2 scheduled task). */
  const defaultSpawnSurvivor = async (file: string): Promise<{ pid: number; method: 'detached' | 'schtasks' }> => {
    const method = current().restartMethod ?? 'auto'
    const powershellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file]
    if (method !== 'schtasks') {
      try {
        const child = spawn('powershell.exe', powershellArgs, { detached: true, windowsHide: true, stdio: 'ignore' })
        child.on('error', () => { /* contained: an unreachable powershell must not crash the host */ })
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => { resolve() })
          child.once('error', (error) => { reject(error) })
        })
        child.unref()
        if (typeof child.pid === 'number' && child.pid > 0) return { pid: child.pid, method: 'detached' }
      } catch { /* fall through to schtasks */ }
      if (method === 'detached') throw new Error('detached spawn failed')
    }
    const taskName = `DSH-Web-Restart-${portFromUrl(current().url ?? DEFAULT_URL)}`
    const commandLine = `powershell.exe ${powershellArgs.map(part => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`
    const created = await runCommand('schtasks', ['/create', '/f', '/tn', taskName, '/tr', commandLine, '/sc', 'once', '/st', '00:00'])
    if (created.code !== 0) throw new Error(`schtasks /create failed: ${created.stderr}`)
    const ran = await runCommand('schtasks', ['/run', '/tn', taskName])
    if (ran.code !== 0) throw new Error(`schtasks /run failed: ${ran.stderr}`)
    return { pid: 0, method: 'schtasks' }
  }

  /** Nonce check for state-changing routes. */
  const nonceOk = (request: IncomingMessage): boolean => request.headers[NONCE_HEADER] === nonce

  /** Shared guard for POST routes: loopback fence, method, nonce. */
  const guardPost = (request: IncomingMessage, res: ServerResponse): boolean => {
    if ((request.method ?? 'GET') !== 'POST') {
      writeJson(res, 405, { error: `method not allowed: ${request.method}` })
      return false
    }
    if (!isLoopbackRequest(request)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', error: 'forbidden: loopback-only' })
      return false
    }
    if (!nonceOk(request)) {
      writeJson(res, 403, { ok: false, code: 'nonce-required', error: `missing or stale ${NONCE_HEADER} header` })
      return false
    }
    return true
  }

  /** Instance identity payload shared by /ping and /status. */
  const instanceInfo = (): Record<string, unknown> => ({
    ok: true,
    plugin: name,
    pluginVersion: PLUGIN_VERSION,
    instanceId,
    nonce,
    pid: process.pid,
    port: resolvedPort(),
    host: '127.0.0.1',
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
  })

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try { dispose?.() } catch { /* already disposed */ }
    }

    const pingRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.ping,
      handler: (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden', error: 'forbidden: loopback-only' })
          return
        }
        writeJson(res, 200, instanceInfo())
      },
    }

    const statusRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.status,
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden', error: 'forbidden: loopback-only' })
          return
        }
        const now = Date.now()
        const [launcher, restart, inflight] = await Promise.all([
          readStatusFile(launcherStatusPath()),
          readStatusFile(restartStatusPath()),
          readInflight(),
        ])
        const value = current()
        writeJson(res, 200, {
          ...instanceInfo(),
          busy: busySnapshot(now),
          config: {
            dshCommand: value.dshCommand ?? DEFAULT_DSH_COMMAND,
            url: value.url ?? DEFAULT_URL,
            profile: value.profile ?? '',
            confirmShutdown: value.confirmShutdown ?? true,
            busyPolicy: value.busyPolicy ?? 'block',
            restartMethod: value.restartMethod ?? 'auto',
            showLaunchReport: value.showLaunchReport ?? true,
          },
          port: {
            listening: true,
            ownerPid: process.pid,
            ownerName: 'node',
            isSelf: true,
          },
          launcher: { statusPath: launcherStatusPath(), ...launcher },
          restart: { statusPath: restartStatusPath(), inflight, ...restart },
          logs: {
            dir: scriptsDir(),
            launcherLog: pathIn(LAUNCHER_FILES.launcherLog),
            restartLog: pathIn(LAUNCHER_FILES.helperLog),
            childOut: pathIn(LAUNCHER_FILES.childOut),
            childErr: pathIn(LAUNCHER_FILES.childErr),
          },
        })
      },
    }

    const createRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.create,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        try {
          writeJson(res, 200, { result: await createDesktopShortcut(launcherSpec) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }

    const restartRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.restart,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        const body = await readJsonBody(req)
        const force = body.force === true
        const graceMs = clampNumber(body.graceMs, current().restartGraceMs ?? DEFAULT_GRACE_MS, 200, 30_000)
        const busy = busySnapshot(Date.now())

        if (blocksOnBusy() && busy.generating && !force) {
          writeJson(res, 409, {
            ok: false,
            code: 'busy',
            busy,
            hint: '有回答正在生成；等它结束后再重启，或在界面里选择「等空闲后自动重启」',
          })
          return
        }
        const inflight = await readInflight()
        if (inflight !== null && !force) {
          writeJson(res, 409, { ok: false, code: 'restart-inflight', inflight })
          return
        }

        try {
          await mkdir(scriptsDir(), { recursive: true })
          await writeJsonFile(restartStatusPath(), {
            schema: 1,
            updatedAt: new Date().toISOString(),
            phase: 'handoff',
            instanceIdBefore: instanceId,
            hostPid: process.pid,
            busyCheck: busy.check,
            busyAtHandoff: busy,
            forced: force,
            message: force ? '已按用户确认强制重启' : '已移交重启助手',
          })
          // UTF-8 BOM: Windows PowerShell 5.1 misreads non-ASCII bodies without it.
          await writeFile(helperPath(), '\uFEFF' + renderRestartHelper(restartSpec(graceMs)))
          const helper = await spawnSurvivor(helperPath())
          await writeJsonFile(inflightPath(), {
            instanceId,
            helperPid: helper.pid,
            at: new Date().toISOString(),
            ttlMs: INFLIGHT_TTL_MS,
          })
          writeJson(res, 202, {
            ok: true,
            accepted: true,
            instanceId,
            statusPath: restartStatusPath(),
            helper: { path: helperPath(), method: helper.method, pid: helper.pid },
            busy,
            forced: force,
            etaMs: 30_000,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await writeRestartPhase('failed', { error: message, hint: '无法启动重启助手；请手动重启 dsh web' })
          await clearInflight()
          writeJson(res, 500, { ok: false, code: 'helper-failed', error: message })
          return
        }

        // Second busy check, right before the handover completes: a turn that
        // started during the grace window cancels the restart instead of being
        // cut off. `force` deliberately skips it.
        setTimeout(() => {
          const recheck = busySnapshot(Date.now())
          if (!force && blocksOnBusy() && recheck.generating) {
            void writeRestartPhase('aborted-busy', {
              busyAtHandoff: recheck,
              error: '检测到新开始的回答，已取消重启',
              hint: '回答结束后可再次点击重启',
            }).then(clearInflight)
            return
          }
          setTimeout(() => requestExit(0), graceMs)
        }, RECHECK_DELAY_MS)
      },
    }

    const shutdownRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.shutdown,
      handler: async (req, res) => {
        if (!guardPost(req, res)) return
        const body = await readJsonBody(req)
        const force = body.force === true
        const busy = busySnapshot(Date.now())
        if (blocksOnBusy() && busy.generating && !force) {
          writeJson(res, 409, {
            ok: false,
            code: 'busy',
            busy,
            hint: '有回答正在生成；等它结束后再退出，或用界面上的强制退出',
          })
          return
        }
        writeJson(res, 200, { ok: true })
        // Flush first: the browser must see the acknowledgement before the
        // process tears down.
        setTimeout(() => requestExit(0), EXIT_DELAY_MS)
      },
    }

    disposers.push(ctx.webServer.register(pingRoute))
    disposers.push(ctx.webServer.register(statusRoute))
    disposers.push(ctx.webServer.register(createRoute))
    disposers.push(ctx.webServer.register(restartRoute))
    disposers.push(ctx.webServer.register(shutdownRoute))

    const value = current()
    if ((value.enabled ?? true) !== false && (value.announceToAgent ?? false) !== false) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:desktop-quick-launcher',
        order: SECTION_ORDER,
        text: DESKTOP_QUICK_LAUNCHER_GUIDANCE,
      })
    }
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NAMESPACE, Config, config ?? {}, {
      setSource: (source: () => Config) => {
        current = source
        sync()
      },
      onChange: sync,
    })
  })

  // Initial registration from the composition entry (deployments without a
  // settings service never fire installSection's hooks).
  sync()

  // Housekeeping for a previous instance: its inflight marker and any leftover
  // L2 scheduled task must not block this one.
  void (async () => {
    try {
      const marker = await readInflight()
      if (marker !== null && marker.instanceId !== instanceId) await clearInflight()
    } catch { /* nothing to clean */ }
    await runCommand('schtasks', ['/delete', '/f', '/tn', `DSH-Web-Restart-${portFromUrl(current().url ?? DEFAULT_URL)}`])
  })()
}
