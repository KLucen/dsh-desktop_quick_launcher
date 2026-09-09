/**
 * desktop-quick-launcher — host half.
 *
 * Migrated core logic from the retired @linxin666/dsh-desktop-launcher
 * (Apache-2.0): serves a loopback-only API family under
 * /api/desktop-quick-launcher:
 *   - POST /create   writes the launcher script under <dsh-home>/
 *                    desktop-quick-launcher/ and places a double-click icon on
 *                    the Desktop (Windows .lnk / macOS .command / Linux
 *                    .desktop);
 *   - POST /shutdown asks the host process to exit gracefully (ctx.appExit,
 *                    process.exit(0) fallback) after the response is flushed.
 *
 * It also owns a schemastery settings section (`desktop-quick-launcher`
 * namespace, edited from Settings) and an optional system-prompt section. The
 * browser half (./client) renders a floating control that triggers both
 * routes. Everything rides the official DSH SDK packages; no dsh source
 * changes.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
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
  DEFAULT_URL,
  desktopFileName,
  renderDesktopEntry,
  renderLauncherScript,
  renderShortcutInstaller,
  resolveLauncherSpec,
  scriptFileName,
  type LauncherPlatform,
  type LauncherSpec,
} from './core/launcher'

const execFileAsync = promisify(execFile)

/** Stable cordis plugin name. */
export const name = 'desktop-quick-launcher'

/** Host services this plugin consumes. */
export const inject = ['webServer', 'systemPrompt']

/** Wire contract between host routes and the browser API helpers. */
export const LAUNCHER_API = {
  /** Create (or refresh) the desktop icon. */
  create: '/api/desktop-quick-launcher/create',
  /** Request the host process to exit gracefully. */
  shutdown: '/api/desktop-quick-launcher/shutdown',
} as const

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
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(false),
  dshCommand: z.string().default(DEFAULT_DSH_COMMAND),
  url: z.string().default(DEFAULT_URL),
  profile: z.string().default(''),
  iconPath: z.string().default(''),
  confirmShutdown: z.boolean().default(true),
})

/** Settings namespace owned by this plugin (host + browser spell the same value). */
const NAMESPACE = 'desktop-quick-launcher'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 210

const DESKTOP_QUICK_LAUNCHER_GUIDANCE =
  '本机已安装 desktop-quick-launcher 插件（DSH 桌面快捷启动 + 一键退出）：' +
  '「设置 → 插件配置」可配置 dshCommand / url / profile；界面右下角悬浮面板可一键「生成/刷新桌面图标」' +
  '（Windows .lnk 双击即启动 dsh web 并打开浏览器）或「停止 DSH 服务」（确认后请求宿主进程优雅退出）。' +
  '限制：图标创建与退出接口均仅限本机回环访问；退出会终止 dsh web 进程，正在运行的会话/任务可能中断。' +
  '用户提到「桌面图标 / 快捷方式 / 一键启动 / 退出 DSH」时即指本插件。'

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
  const isPosix = home.startsWith('/')
  const j = isPosix ? join : join
  const isAbs = isAbsolute
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = raw.trim().startsWith('~')
      ? join(home, raw.trim().slice(1).replace(/^[\\/]/, ''))
      : raw.trim()
    return isAbs(expanded) ? expanded : join(process.cwd(), expanded)
  }
  void j
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
    iconIco = join(scriptsDir, 'dsh.ico')
    await copyFile(iconSource, iconIco)
    if (/\.png$/i.test(iconSource)) {
      iconPng = join(scriptsDir, 'dsh.png')
      await copyFile(iconSource, iconPng)
    } else if (bundledPngPath !== undefined && existsSync(bundledPngPath)) {
      iconPng = join(scriptsDir, 'dsh.png')
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
    const installerPath = join(scriptsDir, 'install-shortcut.ps1')
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

/** How long the exit request waits after the response is flushed. */
const EXIT_DELAY_MS = 500

/**
 * Mount the routes, the shutdown surface, the settings section, and the
 * (optional) system-prompt section.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  let current: () => Config = () => config ?? {}
  let disposeRoutes: (() => void) | undefined
  let disposeShutdown: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  let exitRequested = false
  const requestExit = (code: number): void => {
    if (exitRequested) return
    exitRequested = true
    const exit = ctx.get('appExit')
    if (exit !== undefined) {
      exit(code)
      return
    }
    process.exit(code)
  }

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeShutdown !== undefined) {
      disposeShutdown()
      disposeShutdown = undefined
    }

    // create route (loopback-only)
    const createRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.create,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        try {
          writeJson(res, 200, { result: await createDesktopShortcut(() => resolveLauncherSpec(current())) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }

    // shutdown route (loopback-only, graceful host exit)
    const shutdownRoute: WebRoute = {
      kind: 'exact',
      path: LAUNCHER_API.shutdown,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden' })
          return
        }
        writeJson(res, 200, { ok: true })
        // Flush first: the browser must see the acknowledgement before the
        // process tears down.
        setTimeout(() => requestExit(0), EXIT_DELAY_MS)
      },
    }

    disposeRoutes = ctx.webServer.register(createRoute)
    disposeShutdown = ctx.webServer.register(shutdownRoute)

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
}
