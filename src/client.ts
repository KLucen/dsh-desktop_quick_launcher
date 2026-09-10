/**
 * dsh-desktop_quick_launcher — browser half.
 *
 * A small floating panel pinned to the bottom-right corner of the dsh web page:
 *
 *  - the icon button creates/refreshes the desktop icon and opens the details
 *    popover (instance info, the last launcher report, the last restart report,
 *    and the captured child tail);
 *  - the power button stops the host (custom confirm dialog); the restart button
 *    hands over to the host's detached helper and waits for the new instance
 *    before reloading the page back into the same session.
 *
 * Safety rules the UI mirrors from the host:
 *  - state-changing routes need the per-instance nonce fetched from /ping;
 *  - while a turn is open (`busy.generating`) both buttons are disabled and the
 *    panel offers "restart when idle" instead;
 *  - an override ("force") exists but is reachable only through a second,
 *    explicitly-worded confirmation.
 *
 * Zero client-SDK dependencies: plain fetch + react-dom, inline styles. The host
 * half enforces the loopback fence, the nonce, and the busy guard.
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  formatDuration,
  isLauncherFailure,
  phaseSeverity,
  tailLines,
} from './core/status'
import type { LauncherStatus, RestartStatus } from './core/status'

/** Same-origin /api surface, spelled to match LAUNCHER_API in src/index.ts. */
const API = {
  ping: '/api/dsh-desktop_quick_launcher/ping',
  status: '/api/dsh-desktop_quick_launcher/status',
  create: '/api/dsh-desktop_quick_launcher/create',
  restart: '/api/dsh-desktop_quick_launcher/restart',
  shutdown: '/api/dsh-desktop_quick_launcher/shutdown',
} as const

/** Must match NONCE_HEADER in src/index.ts. */
const NONCE_HEADER = 'x-dsh-ql-nonce'

/** Poll cadence while idle (status) and while waiting for a restart (ping). */
const STATUS_POLL_MS = 3000
const READY_POLL_MS = 1000

/** How long the panel waits for the new instance before giving up. */
const READY_TIMEOUT_MS = 90_000

/** How long a queued "restart when idle" waits for the turn to finish. */
const QUEUE_TIMEOUT_MS = 10 * 60_000

/** localStorage key remembering which launcher failure was already announced. */
const BANNER_KEY = 'dsh-quick-launcher-banner'

export const name = 'dsh-desktop_quick_launcher'

/** No cordis services are required in the browser. */
export const inject: string[] = []

function lang(): 'zh' | 'en' {
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

const T = {
  zh: {
    powerTitle: '停止 DSH Web 服务',
    restartTitle: '重启 DSH Web 服务',
    iconTitle: '桌面图标与状态',
    panelTitle: 'DSH 启动器',
    details: '详情',
    close: '关闭',
    restartQueued: '等空闲后自动重启',
    cancelQueue: '取消排队',
    confirmStopHead: '停止 DSH Web 服务？',
    confirmStopBody: '宿主进程将被优雅退出，当前页面会断开连接。',
    confirmRestartHead: '重启 DSH Web 服务？',
    confirmRestartBody: '宿主会优雅退出，由独立助手拉起新实例；新实例就绪后本页会自动回到当前会话。',
    confirmForceHead: '强制操作：会中断正在生成的回答',
    confirmForceBody: '检测到有回答正在生成。强制继续会切断它，未完成的回答不会保留。确定要继续吗？',
    cancel: '取消',
    confirmStop: '确认停止',
    confirmRestart: '确认重启',
    confirmForce: '确认强制继续',
    working: '正在移交…',
    waiting: '服务重启中… 已等待',
    verifying: '核对新实例…',
    ready: '重启完成（',
    aborted: '已取消：检测到新开始的回答。',
    nonkill: '旧实例尚未停止（助手可能未生效），仍在等待…',
    timedOut: '等待超时：服务可能仍在启动，可稍后手动刷新页面。',
    failed: '操作失败：',
    busyBlocked: '有回答正在生成',
    busyHint: '生成期间不会执行重启或退出，以免切断回答。',
    noNonce: '无法获取一次性校验码，请刷新页面后重试。',
    errCreate: '生成失败：',
    toastOk: '已生成：',
    toastWarn: '警告：',
    bannerPrefix: '上次桌面图标启动失败：',
    dismiss: '知道了',
    sectionInstance: '实例',
    sectionBusy: '生成状态',
    sectionLaunch: '上次启动报告',
    sectionRestart: '上次重启报告',
    sectionLogs: '日志',
    pid: 'PID',
    port: '端口',
    uptime: '运行时长',
    version: '版本',
    generating: '生成中',
    idle: '空闲',
    quiet: '已静默',
    noData: '（暂无记录）',
    tail: '输出尾部',
    busyUnknown: '无法检测，将放行',
    revealHint: '打开下面的目录可查看完整日志',
    hint: '建议',
    busyRefused: '宿主拒绝：当前有回答正在生成。',
    inflightRefused: '已有一次重启正在进行，请稍候。',
  },
  en: {
    powerTitle: 'Stop the DSH web service',
    restartTitle: 'Restart the DSH web service',
    iconTitle: 'Desktop icon and status',
    panelTitle: 'DSH launcher',
    details: 'Details',
    close: 'Close',
    restartQueued: 'Restart when idle',
    cancelQueue: 'Cancel queue',
    confirmStopHead: 'Stop the DSH web service?',
    confirmStopBody: 'The host process will exit and this page will disconnect.',
    confirmRestartHead: 'Restart the DSH web service?',
    confirmRestartBody: 'The host exits gracefully and a detached helper starts a new instance; this page returns to the same session once it is ready.',
    confirmForceHead: 'Force: this interrupts the answer being generated',
    confirmForceBody: 'A turn is currently generating. Continuing cuts it off and the unfinished answer is not kept. Continue?',
    cancel: 'Cancel',
    confirmStop: 'Stop',
    confirmRestart: 'Restart',
    confirmForce: 'Force anyway',
    working: 'Handing over…',
    waiting: 'Restarting… waited',
    verifying: 'Checking the new instance…',
    ready: 'Restart complete (',
    aborted: 'Cancelled: a new answer had started.',
    nonkill: 'The old instance is still running (the helper may not have taken effect); still waiting…',
    timedOut: 'Timed out: the service may still be starting — try refreshing the page later.',
    failed: 'Failed: ',
    busyBlocked: 'An answer is being generated',
    busyHint: 'Restart and stop stay disabled while generating so the answer is never cut off.',
    noNonce: 'Could not obtain the one-time token — refresh the page and retry.',
    errCreate: 'Create failed: ',
    toastOk: 'Created: ',
    toastWarn: 'Warning: ',
    bannerPrefix: 'The last desktop-icon launch failed: ',
    dismiss: 'Dismiss',
    sectionInstance: 'Instance',
    sectionBusy: 'Generation',
    sectionLaunch: 'Last launch report',
    sectionRestart: 'Last restart report',
    sectionLogs: 'Logs',
    pid: 'PID',
    port: 'Port',
    uptime: 'Uptime',
    version: 'Version',
    generating: 'generating',
    idle: 'idle',
    quiet: 'quiet for',
    noData: '(nothing recorded yet)',
    tail: 'Output tail',
    busyUnknown: 'undetectable — will allow',
    revealHint: 'Open the directory below for the full logs',
    hint: 'Hint',
    busyRefused: 'Refused: an answer is being generated.',
    inflightRefused: 'A restart is already in flight — please wait.',
  },
}[lang()]

/** Launcher/restart phase → user-facing label. */
const PHASE_TEXT: Record<string, { zh: string; en: string }> = {
  invoked: { zh: '已启动', en: 'started' },
  'mutex-held': { zh: '另一启动流程进行中，已转为等待', en: 'another launcher was starting; waited instead' },
  spawned: { zh: '正在启动 dsh', en: 'starting dsh' },
  ready: { zh: '成功：服务已就绪并打开浏览器', en: 'ok: service ready, browser opened' },
  'up-dsh': { zh: '服务已在运行', en: 'service was already running' },
  'up-unknown': { zh: '端口被其他程序占用', en: 'the port is held by another program' },
  'port-no-response': { zh: '端口被占用但无响应（疑似僵死实例）', en: 'port held but unresponsive (likely a stuck instance)' },
  down: { zh: '端口空闲', en: 'port free' },
  'dsh-not-found': { zh: '找不到 dsh 命令', en: 'dsh command not found' },
  'child-exit': { zh: 'dsh 启动后立即退出', en: 'dsh exited right after starting' },
  'timeout-alive': { zh: '进程在跑但一直未响应', en: 'process alive but never answered' },
  'timeout-dead': { zh: '未就绪且进程已退出', en: 'process exited before becoming ready' },
  error: { zh: '启动流程异常', en: 'launcher crashed' },
  handoff: { zh: '已移交重启助手', en: 'handed over to the helper' },
  'verifying-old': { zh: '确认旧实例已退出', en: 'verifying the old instance is gone' },
  killing: { zh: '兜底清理旧进程', en: 'fallback cleanup of the old process' },
  spawning: { zh: '正在启动新实例', en: 'starting the new instance' },
  timeout: { zh: '新实例未就绪', en: 'the new instance never became ready' },
  failed: { zh: '重启失败', en: 'restart failed' },
  'aborted-busy': { zh: '已取消（检测到新回答）', en: 'cancelled (a new answer started)' },
}

function phaseLabel(phase: string): string {
  const entry = PHASE_TEXT[phase]
  if (entry === undefined) return phase
  return lang() === 'zh' ? entry.zh : entry.en
}

/** One /status snapshot. */
interface StatusPayload {
  ok: boolean
  instanceId: string
  nonce: string
  pid: number
  port: number
  uptimeMs: number
  pluginVersion: string
  busy: {
    known: boolean
    check: string
    generating: boolean
    openTurns: { sessionId: string; turn: number; quietMs: number }[]
  }
  launcher: { statusPath: string; ageMs: number | null; report: LauncherStatus | null; readError: string | null }
  restart: {
    statusPath: string
    ageMs: number | null
    report: RestartStatus | null
    readError: string | null
    inflight: { helperPid: number; at: string; ttlMs: number } | null
  }
  logs: { dir: string; launcherLog: string; restartLog: string; childOut: string; childErr: string }
}

type Phase =
  | 'idle'
  | 'posting'
  | 'waiting'
  | 'nonkill'
  | 'verifying'
  | 'ready'
  | 'aborted'
  | 'failed'
  | 'timeout'
  | 'queued'

type DialogKind = null | 'stop' | 'restart' | 'force-stop' | 'force-restart'

interface Toast { kind: 'ok' | 'warn' | 'err'; text: string }

// ---- transport ------------------------------------------------------------

async function getJson(path: string): Promise<StatusPayload | null> {
  try {
    const response = await fetch(path, { cache: 'no-store' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    return body as StatusPayload
  } catch {
    return null
  }
}

interface PostResult { status: number; body: Record<string, unknown> }

async function postJson(path: string, payload: Record<string, unknown>, nonce: string): Promise<PostResult> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [NONCE_HEADER]: nonce },
    body: JSON.stringify(payload),
  })
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
  } catch { /* an empty body is fine */ }
  return { status: response.status, body }
}

/** Replace the page so the user does not stare at a dead-server error. */
function closeCurrentPage(): void {
  window.close()
  if (!window.closed) window.location.replace('about:blank')
}

// ---- styles ---------------------------------------------------------------

const ROUND_BTN: CSSProperties = {
  width: '44px',
  height: '44px',
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,.14)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: '#fff',
  boxShadow: '0 4px 14px rgba(0,0,0,.35)',
}

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: '0',
  zIndex: 2147483003,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const DIALOG: CSSProperties = {
  background: '#1B1E27',
  color: '#F2F3F5',
  borderRadius: '14px',
  padding: '20px 22px',
  width: 'min(380px, 86vw)',
  boxShadow: '0 10px 40px rgba(0,0,0,.5)',
  border: '1px solid rgba(255,255,255,.08)',
  fontSize: '14px',
  lineHeight: 1.6,
}

const DIALOG_ACTIONS: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }

const BTN: CSSProperties = {
  border: '0',
  borderRadius: '8px',
  padding: '7px 16px',
  cursor: 'pointer',
  fontSize: '13px',
  color: '#fff',
  background: '#3a3f4b',
}

const BTN_DANGER: CSSProperties = { ...BTN, background: '#E54D4D' }
const BTN_PRIMARY: CSSProperties = { ...BTN, background: '#4D6BFE' }

const TOAST: CSSProperties = {
  position: 'fixed',
  right: '18px',
  bottom: '84px',
  zIndex: 2147483002,
  background: '#1B1E27',
  color: '#F2F3F5',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '10px',
  padding: '8px 12px',
  fontSize: '12px',
  maxWidth: '70vw',
  boxShadow: '0 6px 20px rgba(0,0,0,.4)',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
}

const INLINE_NOTE: CSSProperties = {
  ...TOAST,
  position: 'fixed',
  right: '18px',
  bottom: '150px',
  maxWidth: 'min(420px, 90vw)',
}

const PANEL: CSSProperties = {
  position: 'fixed',
  right: '18px',
  bottom: '78px',
  zIndex: 2147483001,
  width: 'min(430px, 92vw)',
  maxHeight: '70vh',
  overflowY: 'auto',
  background: '#1B1E27',
  color: '#F2F3F5',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '12px',
  padding: '14px 16px',
  fontSize: '12px',
  lineHeight: 1.65,
  boxShadow: '0 10px 40px rgba(0,0,0,.5)',
}

const BANNER: CSSProperties = {
  position: 'fixed',
  right: '18px',
  bottom: '84px',
  zIndex: 2147483002,
  maxWidth: 'min(420px, 90vw)',
  background: '#2A1E1E',
  color: '#F2F3F5',
  border: '1px solid #E54D4D66',
  borderRadius: '10px',
  padding: '10px 12px',
  fontSize: '12px',
  boxShadow: '0 8px 26px rgba(0,0,0,.45)',
}

const SECTION_TITLE: CSSProperties = { fontWeight: 600, marginTop: '10px', color: '#C8CDDA' }
const MUTED: CSSProperties = { color: '#9BA1B0' }
const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '11px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  background: 'rgba(255,255,255,.04)',
  borderRadius: '6px',
  padding: '6px 8px',
  margin: '4px 0 0',
}

// ---- glyphs ---------------------------------------------------------------

function PowerGlyph() {
  return createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
    createElement('path', { d: 'M12 2v10' }),
    createElement('path', { d: 'M18.4 6.6a9 9 0 1 1-12.8 0' }),
  )
}

function IconGlyph() {
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    createElement('rect', { x: '2', y: '3', width: '20', height: '13', rx: '2' }),
    createElement('path', { d: 'M8 21h8M12 16v5' }),
  )
}

function RestartGlyph() {
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    createElement('path', { d: 'M21 12a9 9 0 1 1-2.6-6.4' }),
    createElement('path', { d: 'M21 3v5h-5' }),
  )
}

// ---- panel ----------------------------------------------------------------

function FloatingPanel() {
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [nonce, setNonce] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [note, setNote] = useState('')
  const [toast, setToast] = useState<Toast | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const savedHref = useRef('')
  const beforeId = useRef('')
  const timer = useRef<number | null>(null)

  const flash = useCallback((kind: Toast['kind'], text: string): void => {
    setToast({ kind, text })
    window.setTimeout(() => { setToast(null) }, 7000)
  }, [])

  const stopTimer = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const refresh = useCallback(async (): Promise<StatusPayload | null> => {
    const next = await getJson(API.status)
    if (next !== null) {
      setStatus(next)
      if (typeof next.nonce === 'string' && next.nonce !== '') setNonce(next.nonce)
    }
    return next
  }, [])

  const ensureNonce = useCallback(async (): Promise<string | null> => {
    if (nonce !== null) return nonce
    const next = await getJson(API.ping)
    const value = next?.nonce
    if (typeof value !== 'string' || value === '') {
      flash('err', T.noNonce)
      return null
    }
    setNonce(value)
    return value
  }, [flash, nonce])

  // Initial identity + the one-time launcher-failure banner.
  useEffect(() => {
    void (async () => {
      const next = await refresh()
      if (next === null) return
      const report = next.launcher.report
      if (report === null || !isLauncherFailure(report.phase)) return
      if (next.launcher.ageMs !== null && next.launcher.ageMs > 24 * 3600_000) return
      let seen = ''
      try { seen = window.localStorage.getItem(BANNER_KEY) ?? '' } catch { /* storage disabled */ }
      if (seen === report.updatedAt) return
      try { window.localStorage.setItem(BANNER_KEY, report.updatedAt) } catch { /* storage disabled */ }
      setBanner(T.bannerPrefix + phaseLabel(report.phase) + ' — ' + report.message)
    })()
  }, [refresh])

  // Idle polling of the status snapshot.
  useEffect(() => {
    if (phase !== 'idle') return
    const id = window.setInterval(() => { void refresh() }, STATUS_POLL_MS)
    return () => { window.clearInterval(id) }
  }, [phase, refresh])

  const generating = status?.busy.generating === true
  const busyKnown = status?.busy.known !== false
  const openTurns = status?.busy.openTurns ?? []

  // ---- restart / stop flows ----

  const verify = useCallback(async (): Promise<void> => {
    setPhase('verifying')
    const next = await refresh()
    const report = next?.restart.report ?? null
    if (report === null) {
      setPhase('failed')
      setNote(T.failed + phaseLabel('failed'))
      return
    }
    if (report.phase === 'ready') {
      setPhase('ready')
      const waited = report.ready?.waitedMs
      setNote(T.ready + (typeof waited === 'number' ? formatDuration(waited) : '') + ')')
      window.setTimeout(() => {
        window.location.replace(savedHref.current === '' ? '/' : savedHref.current)
      }, 2000)
      return
    }
    if (report.phase === 'aborted-busy') {
      setPhase('aborted')
      setNote(T.aborted)
      return
    }
    setPhase('failed')
    setNote(T.failed + (report.error ?? phaseLabel(report.phase)) + (report.hint === undefined || report.hint === '' ? '' : `\n${T.hint}：${report.hint}`))
  }, [refresh])

  const waitForReady = useCallback((): void => {
    const started = Date.now()
    const tick = async (): Promise<void> => {
      if (Date.now() - started > READY_TIMEOUT_MS) {
        setPhase('timeout')
        setNote(T.timedOut)
        return
      }
      try {
        const response = await fetch(API.ping, { cache: 'no-store' })
        if (response.ok) {
          const body: unknown = await response.json()
          const info = (typeof body === 'object' && body !== null ? body : {}) as { instanceId?: unknown; nonce?: unknown }
          if (typeof info.nonce === 'string' && info.nonce !== '') setNonce(info.nonce)
          if (typeof info.instanceId === 'string' && info.instanceId !== beforeId.current) {
            await verify()
            return
          }
          if (Date.now() - started > 15_000) setPhase('nonkill')
        }
      } catch { /* the service is down mid-restart: expected */ }
      timer.current = window.setTimeout(() => { void tick() }, READY_POLL_MS)
    }
    void tick()
  }, [verify])

  const submit = useCallback(async (path: string, force: boolean, restart: boolean): Promise<void> => {
    const header = await ensureNonce()
    if (header === null) return
    savedHref.current = window.location.href
    beforeId.current = status?.instanceId ?? ''
    setPhase('posting')
    setNote(T.working)
    try {
      const result = await postJson(path, { force }, header)
      if (result.status === 409) {
        setPhase('idle')
        setNote(result.body.code === 'busy' ? T.busyRefused : T.inflightRefused)
        void refresh()
        return
      }
      if (result.status < 200 || result.status >= 300) {
        setPhase('failed')
        setNote(T.failed + String(result.body.error ?? `HTTP ${result.status}`))
        return
      }
      if (!restart) {
        setPhase('idle')
        setNote('')
        window.setTimeout(closeCurrentPage, 700)
        return
      }
      setPhase('waiting')
      setNote(`${T.waiting} 0s`)
      waitForReady()
    } catch (error) {
      setPhase('failed')
      setNote(T.failed + (error instanceof Error ? error.message : String(error)))
    }
  }, [ensureNonce, refresh, status, waitForReady])

  // Keep the queue's interval independent of `submit` identity churn.
  const submitRef = useRef(submit)
  useEffect(() => { submitRef.current = submit }, [submit])

  // Queued "restart when idle": mirrors the host guard, never bypasses it.
  useEffect(() => {
    if (phase !== 'queued') return
    const started = Date.now()
    const id = window.setInterval(() => {
      void (async () => {
        if (Date.now() - started > QUEUE_TIMEOUT_MS) {
          setPhase('idle')
          setNote(T.timedOut)
          return
        }
        const next = await getJson(API.status)
        if (next === null) return
        setStatus(next)
        if (typeof next.nonce === 'string' && next.nonce !== '') setNonce(next.nonce)
        if (!next.busy.generating) {
          window.clearInterval(id)
          void submitRef.current(API.restart, false, true)
        }
      })()
    }, STATUS_POLL_MS)
    return () => { window.clearInterval(id) }
  }, [phase])

  // Ticking elapsed time while waiting for the new instance.
  useEffect(() => {
    if (phase !== 'waiting' && phase !== 'nonkill') return
    const started = Date.now()
    const id = window.setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000)
      setNote(phase === 'waiting' ? `${T.waiting} ${seconds}s` : T.nonkill)
    }, 1000)
    return () => { window.clearInterval(id) }
  }, [phase])

  useEffect(() => () => { stopTimer() }, [stopTimer])

  // ---- actions ----

  const onCreate = async (): Promise<void> => {
    const header = await ensureNonce()
    if (header === null) return
    setWorking(true)
    try {
      const result = await postJson(API.create, {}, header)
      if (result.status < 200 || result.status >= 300) {
        flash('err', T.errCreate + String(result.body.error ?? `HTTP ${result.status}`))
        return
      }
      const info = (result.body.result ?? {}) as { path?: string; warning?: string }
      const parts = [T.toastOk, info.path ?? '']
      if (info.warning !== undefined) parts.push(`\n${T.toastWarn}${info.warning}`)
      flash('ok', parts.join(''))
      setDetailsOpen(true)
      void refresh()
    } catch (error) {
      flash('err', T.errCreate + (error instanceof Error ? error.message : String(error)))
    } finally {
      setWorking(false)
    }
  }

  const onConfirm = async (): Promise<void> => {
    const kind = dialog
    setDialog(null)
    if (kind === null) return
    setWorking(true)
    try {
      if (kind === 'stop') await submit(API.shutdown, false, false)
      else if (kind === 'restart') await submit(API.restart, false, true)
      else if (kind === 'force-stop') await submit(API.shutdown, true, false)
      else await submit(API.restart, true, true)
    } finally {
      setWorking(false)
    }
  }

  const requestOperation = (restart: boolean): void => {
    setDialog(generating ? (restart ? 'force-restart' : 'force-stop') : (restart ? 'restart' : 'stop'))
  }

  // ---- rendering ----

  const renderReport = (
    title: string,
    phase: string,
    message: string,
    hint: string | undefined,
    tail: string | undefined,
  ) => createElement('div', null,
    createElement('div', { style: SECTION_TITLE }, title),
    createElement('div', { style: { color: phaseSeverity(phase) === 'error' ? '#E58A8A' : '#C8CDDA' } }, phaseLabel(phase)),
    message === '' ? null : createElement('div', { style: MUTED }, message),
    hint === undefined || hint === '' ? null : createElement('div', { style: MUTED }, `${T.hint}：${hint}`),
    tail === undefined || tail === '' ? null : createElement('div', null,
      createElement('div', { style: MUTED }, T.tail),
      createElement('pre', { style: MONO }, tailLines(tail, 15)),
    ),
  )

  const launcherReport = status?.launcher.report ?? null
  const restartReport = status?.restart.report ?? null
  const busyLine = status === null
    ? T.noData
    : status.busy.known
      ? (status.busy.generating
        ? `${T.generating}: ${openTurns.map(turn => `${turn.sessionId} #${turn.turn}（${T.quiet} ${formatDuration(turn.quietMs)}）`).join('，')}`
        : T.idle)
      : `${T.busyUnknown} — ${status.busy.check}`

  return createElement('div', null,
    toast === null ? null : createElement('div', {
      style: toast.kind === 'err' || toast.kind === 'warn' ? { ...TOAST, borderColor: '#E54D4D66' } : TOAST,
    }, toast.text),

    banner === null ? null : createElement('div', { style: BANNER },
      createElement('div', null, banner),
      createElement('div', { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
        createElement('button', { style: BTN, onClick: () => { setBanner(null); setDetailsOpen(true) } }, T.details),
        createElement('button', { style: BTN, onClick: () => { setBanner(null) } }, T.dismiss),
      ),
    ),

    createElement('div', { style: { position: 'fixed', right: '18px', bottom: '18px', zIndex: 2147483000, display: 'flex', gap: '10px' } },
      createElement('button', {
        style: { ...ROUND_BTN, background: '#4D6BFE' },
        title: T.iconTitle,
        'aria-label': T.iconTitle,
        onClick: () => { setDetailsOpen(open => !open); void refresh() },
      }, createElement(IconGlyph)),
      createElement('button', {
        style: { ...ROUND_BTN, background: generating ? '#3a3f4b' : '#E54D4D', opacity: generating ? 0.6 : 1, cursor: generating ? 'not-allowed' : 'pointer' },
        title: generating ? `${T.busyBlocked} — ${T.busyHint}` : T.powerTitle,
        'aria-label': T.powerTitle,
        disabled: generating,
        onClick: () => { if (!generating) requestOperation(false) },
      }, createElement(PowerGlyph)),
      createElement('button', {
        style: { ...ROUND_BTN, background: generating ? '#3a3f4b' : '#2F7D5B', opacity: generating ? 0.6 : 1, cursor: generating ? 'not-allowed' : 'pointer' },
        title: generating ? `${T.busyBlocked} — ${T.busyHint}` : T.restartTitle,
        'aria-label': T.restartTitle,
        disabled: generating,
        onClick: () => { if (!generating) requestOperation(true) },
      }, createElement(RestartGlyph)),
    ),

    generating || phase === 'queued' ? createElement('div', { style: INLINE_NOTE },
      createElement('div', null, `${T.busyBlocked}: ${openTurns.length || '?'}${busyKnown ? '' : `（${T.busyUnknown}）`}`),
      createElement('div', { style: { ...MUTED, marginTop: '4px' } }, T.busyHint),
      createElement('div', { style: { marginTop: '8px' } },
        phase === 'queued'
          ? createElement('button', { style: BTN, onClick: () => { setPhase('idle'); setNote('') } }, T.cancelQueue)
          : createElement('button', { style: BTN_PRIMARY, onClick: () => { setPhase('queued'); setNote(T.restartQueued) } }, T.restartQueued),
      ),
    ) : null,

    phase !== 'idle' && note !== '' ? createElement('div', {
      style: { ...TOAST, bottom: '220px', borderColor: phaseSeverity(phase) === 'error' ? '#E54D4D66' : undefined },
    }, note) : null,

    detailsOpen ? createElement('div', { style: PANEL },
      createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        createElement('div', { style: { fontWeight: 600, fontSize: '13px' } }, T.panelTitle),
        createElement('button', { style: BTN, onClick: () => { setDetailsOpen(false) } }, T.close),
      ),
      status === null
        ? createElement('div', { style: MUTED }, T.noData)
        : createElement('div', null,
          createElement('div', { style: SECTION_TITLE }, T.sectionInstance),
          createElement('div', { style: MUTED },
            `${T.pid} ${status.pid} · ${T.port} ${status.port} · ${T.uptime} ${formatDuration(status.uptimeMs)} · ${T.version} ${status.pluginVersion}`),
          createElement('div', { style: SECTION_TITLE }, T.sectionBusy),
          createElement('div', { style: MUTED }, busyLine),
          launcherReport === null
            ? createElement('div', null,
              createElement('div', { style: SECTION_TITLE }, T.sectionLaunch),
              createElement('div', { style: MUTED }, T.noData))
            : renderReport(T.sectionLaunch, launcherReport.phase, launcherReport.message, launcherReport.hint, launcherReport.child?.tail),
          restartReport === null
            ? createElement('div', null,
              createElement('div', { style: SECTION_TITLE }, T.sectionRestart),
              createElement('div', { style: MUTED }, T.noData))
            : renderReport(T.sectionRestart, restartReport.phase, restartReport.error ?? '', restartReport.hint, restartReport.childTail),
          createElement('div', { style: SECTION_TITLE }, T.sectionLogs),
          createElement('div', { style: MUTED }, T.revealHint),
          createElement('pre', { style: MONO }, status.logs.dir),
        ),
    ) : null,

    dialog === null ? null : createElement('div', {
      style: OVERLAY,
      onClick: () => { if (!working) setDialog(null) },
    },
      createElement('div', {
        style: DIALOG,
        onClick: (event: { stopPropagation(): void }) => { event.stopPropagation() },
      },
        createElement('div', { style: { fontWeight: 600, fontSize: '15px' } },
          dialog === 'stop' ? T.confirmStopHead
            : dialog === 'restart' ? T.confirmRestartHead
              : T.confirmForceHead),
        createElement('p', { style: { margin: '8px 0 0', color: '#9BA1B0', fontSize: '13px' } },
          dialog === 'stop' ? T.confirmStopBody
            : dialog === 'restart' ? T.confirmRestartBody
              : T.confirmForceBody),
        createElement('div', { style: DIALOG_ACTIONS },
          createElement('button', { style: BTN, onClick: () => { setDialog(null) }, disabled: working }, T.cancel),
          createElement('button', {
            style: dialog === 'stop' || dialog === 'restart' ? BTN_PRIMARY : BTN_DANGER,
            onClick: () => { void onConfirm() },
            disabled: working,
          },
            dialog === 'stop' ? T.confirmStop
              : dialog === 'restart' ? T.confirmRestart
                : T.confirmForce),
        ),
      ),
    ),
  )
}

let mounted = false

/**
 * Mount the floating control once into document.body.
 * @param _ctx - client root context (unused; kept for loader compatibility).
 */
export function apply(_ctx: unknown): void {
  if (mounted) return
  if (typeof document === 'undefined') return
  mounted = true
  const host = document.createElement('div')
  host.dataset.dshQuickLauncher = 'true'
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(createElement(FloatingPanel))
}

export default { name, inject, apply }
