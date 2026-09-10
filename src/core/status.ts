/**
 * Status vocabulary shared by the host half and the browser half.
 *
 * This module is deliberately free of node built-ins: the client bundle
 * (scripts/wrap-client.mjs) imports it too, so it must stay a pure
 * types+functions module. The PowerShell halves (launcher + restart helper)
 * write files in exactly these shapes; `parseStatusFile` is the single
 * tolerant reader so a half-written or newer-schema file degrades to an
 * error string instead of throwing.
 */

import type { OpenTurn } from './busy'

/** Result class of the launcher's tiered probe (see renderProbeFunctions). */
export type ProbeClass = 'up-dsh' | 'up-unknown' | 'port-no-response' | 'down'

/** What the probe observed on the configured port. */
export interface ProbeInfo {
  class: ProbeClass
  /** HTTP status of the classifier request, when one answered. */
  status?: number
  /** True when the port answers DSH but the browser needs the token URL. */
  authRequired?: boolean
  checkedAt: string
}

/** Occupant of the configured port. */
export interface PortOwnerInfo {
  listening: boolean
  ownerPid?: number
  ownerName?: string
  ownerPath?: string
  /** True when the occupant is this host process (the normal case). */
  isSelf?: boolean
}

/** The spawned `dsh web` child, if one was started. */
export interface ChildInfo {
  pid?: number
  exitCode?: number | null
  outLog?: string
  errLog?: string
  /** Tail of the captured stdout/stderr — the whole point of v0.2 diagnostics. */
  tail?: string
}

/** Single-instance guard state. */
export interface MutexInfo {
  acquired: boolean
  waitedForExisting: boolean
}

/**
 * Launcher run outcome. The lifecycle values (`invoked`, `spawned`) are
 * progress markers; the rest double as the failure taxonomy the GUI renders.
 */
export type LauncherPhase =
  | 'invoked'
  | 'mutex-held'
  | 'spawned'
  | 'ready'
  | 'up-dsh'
  | 'up-unknown'
  | 'port-no-response'
  | 'down'
  | 'dsh-not-found'
  | 'child-exit'
  | 'timeout-alive'
  | 'timeout-dead'
  | 'error'

/** `launcher-status.json` — written by the generated launcher script. */
export interface LauncherStatus {
  schema: 1
  updatedAt: string
  phase: LauncherPhase
  probe?: ProbeInfo
  port?: PortOwnerInfo
  child?: ChildInfo
  mutex?: MutexInfo
  /** Human-readable conclusion (Chinese: it also feeds the desktop message box). */
  message: string
  /** Suggested next step, shown alongside the message. */
  hint?: string
}

/** `restart-status.json` — written by the host at handoff and by the helper. */
export type RestartPhase =
  | 'handoff'
  | 'verifying-old'
  | 'killing'
  | 'spawning'
  | 'ready'
  | 'timeout'
  | 'failed'
  | 'aborted-busy'

/** One process the fallback killer had to stop. */
export interface KilledProcess {
  pid: number
  name?: string
  reason: string
}

/** The replacement `dsh web` process. */
export interface SpawnedProcess {
  pid?: number
  command?: string
  args?: string[]
}

/** Proof the new instance is the one that answered after the handoff. */
export interface RestartReady {
  instanceId?: string
  pid?: number
  waitedMs?: number
}

/** Whether any session currently has a turn open — i.e. is generating. */
export interface BusySnapshot {
  /**
   * False when the check itself could not run (sessions service missing or its
   * API changed). The host then fails OPEN and records `check`, because a
   * fail-closed check would disable restart forever.
   */
  known: boolean
  check: string
  generating: boolean
  openTurns: OpenTurn[]
  checkedAt: string
}

export interface RestartStatus {
  schema: 1
  updatedAt: string
  phase: RestartPhase
  /** Identity of the instance that requested the restart. */
  instanceIdBefore?: string
  hostPid?: number
  helperPid?: number
  helperMethod?: 'detached' | 'schtasks'
  busyCheck?: string
  busyAtHandoff?: BusySnapshot
  /** True when the user overrode the busy guard after an explicit confirmation. */
  forced?: boolean
  killed?: KilledProcess[]
  spawned?: SpawnedProcess
  ready?: RestartReady
  /** Token URL printed by the new instance, for when the cookie is gone. */
  authUrl?: string
  childTail?: string
  error?: string
  hint?: string
}

export type StatusFile = LauncherStatus | RestartStatus

export type ParseResult =
  | { ok: true; value: StatusFile }
  | { ok: false; error: string }

/** Strip a UTF-8 BOM; PowerShell 5.1 loves to add one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parse a status file tolerantly. Only the fields the two halves depend on are
 * validated (`schema`, `updatedAt`, `phase`); everything else passes through so
 * a newer writer does not break an older reader.
 * @param text - raw file contents.
 * @returns the parsed object, or a reason it could not be used.
 */
export function parseStatusFile(text: string): ParseResult {
  const body = stripBom(text).trim()
  if (body === '') return { ok: false, error: 'empty status file' }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'status file is not a JSON object' }
  }
  const record = value as Record<string, unknown>
  if (record.schema !== 1) return { ok: false, error: `unsupported schema: ${String(record.schema)}` }
  if (typeof record.phase !== 'string' || record.phase === '') return { ok: false, error: 'missing phase' }
  if (typeof record.updatedAt !== 'string' || record.updatedAt === '') return { ok: false, error: 'missing updatedAt' }
  return { ok: true, value: value as StatusFile }
}

/**
 * Last `n` lines of a log, for the GUI panel and the desktop message box.
 * @param text - raw log contents (may be empty).
 * @param n - how many trailing lines to keep.
 * @returns the tail, without a trailing newline.
 */
export function tailLines(text: string, n: number): string {
  if (text === '' || n <= 0) return ''
  const lines = stripBom(text).split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return ''
  return lines.slice(-n).join('\n')
}

/** Severity of one phase, used for badges and the one-time startup banner. */
export type PhaseSeverity = 'ok' | 'info' | 'warn' | 'error'

/**
 * Map either phase enum onto a severity. `aborted-busy` is an intentional
 * cancellation, not a failure, so it stays a warning.
 * @param phase - launcher or restart phase.
 * @returns the severity the GUI should render.
 */
export function phaseSeverity(phase: string): PhaseSeverity {
  switch (phase) {
    case 'ready':
    case 'up-dsh':
      return 'ok'
    case 'invoked':
    case 'mutex-held':
    case 'down':
    case 'spawned':
    case 'handoff':
    case 'verifying-old':
    case 'killing':
    case 'spawning':
      return 'info'
    case 'aborted-busy':
      return 'warn'
    case 'up-unknown':
    case 'port-no-response':
    case 'dsh-not-found':
    case 'child-exit':
    case 'timeout-alive':
    case 'timeout-dead':
    case 'error':
    case 'failed':
    case 'timeout':
      return 'error'
    default:
      return 'info'
  }
}

/** True when the launcher phase means "the icon failed to start DSH". */
export function isLauncherFailure(phase: string): boolean {
  return phaseSeverity(phase) === 'error'
}

/**
 * Short human duration: `820ms`, `12.4s`, `1m 03s`.
 * @param ms - duration in milliseconds.
 * @returns the formatted duration.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}
