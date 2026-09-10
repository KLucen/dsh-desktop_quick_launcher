import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/core/launcher.d.ts
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
type LauncherPlatform = 'win32' | 'darwin' | 'linux';
/** Launcher behavior, resolved from plugin config. */
interface LauncherSpec {
  /** Command that starts dsh (must be on PATH when the launcher runs). */
  dshCommand: string;
  /** Base URL of the dsh web GUI. */
  url: string;
  /** Listen port the probe targets; normally `ctx.webServer.port`. */
  port: number;
  /** Optional profile started as `dsh --profile <profile> --no-open`. */
  profile?: string;
  /** Optional icon file (.ico/.png); empty uses the bundled dsh icon. */
  iconPath?: string;
}
/** Everything the generated restart helper needs, baked into the script. */
interface RestartSpec {
  /** Listen port of the host being restarted. */
  port: number;
  /** GUI URL (probe target). */
  url: string;
  /** PID of the host that requested the restart. */
  hostPid: number;
  /** How long to leave the host alone before checking whether it exited. */
  graceMs: number;
  /** Command that starts dsh. */
  dshCommand: string;
  /** Optional profile. */
  profile?: string;
  /** Identity of the instance that requested the restart (readiness proof). */
  instanceIdBefore: string;
  /** Readiness budget in seconds. */
  waitSeconds: number;
  /**
   * Working directory the replacement must start in. A scheduled task starts in
   * `%SystemRoot%\System32`, so this has to be restored explicitly — otherwise
   * the new host comes up with the wrong workspace.
   */
  cwd: string;
  /**
   * DSH home to export for the replacement. A scheduled task inherits the user
   * environment, which may not carry a custom `DSH_HOME`.
   */
  dshHome: string;
}
/** Port implied by a URL, falling back to the plugin default. */
declare function portFromUrl(url: string, fallback?: number): number;
/** Resolve defaults from a partial config; empty profile means "no --profile flag". */
declare function resolveLauncherSpec(config: {
  dshCommand?: string;
  url?: string;
  port?: number;
  profile?: string;
  iconPath?: string;
}): LauncherSpec;
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
declare function renderScheduledTaskCommand(helperPath: string): string;
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
declare function renderRestartHelper(spec: RestartSpec): string;
/** Render the launcher script for one platform. */
declare function renderLauncherScript(platform: LauncherPlatform, spec: LauncherSpec): string;
//#endregion
//#region src/core/busy.d.ts
/**
 * Open-turn detection: the host-side answer to "is an answer being generated
 * right now?".
 *
 * DSH session logs pair `turn/start` … `turn/end`. A session whose last turn
 * boundary is `turn/start` has an open turn — this is the harness's own
 * definition, used by `@deepseek-ai/dsh-session`'s fork guard
 * (`lib/types/index.js`, `OPEN_TURN`). The plugin reuses that semantic instead
 * of inventing a heuristic, so a restart can be refused BEFORE it interrupts a
 * running answer.
 *
 * Pure module: no node built-ins, no IO — the host passes in event arrays it
 * read from `ctx.sessions.list()`.
 */
/** The only event fields this module needs. */
interface SessionEventLike {
  type: string;
  /** ISO timestamp assigned by the session log. */
  time?: string;
  data?: {
    turn?: number;
  };
}
/** One live session reduced to what the check needs. */
interface SessionView {
  id: string;
  events: readonly SessionEventLike[];
}
/** A session with an unfinished turn. */
interface OpenTurn {
  sessionId: string;
  /** Turn number carried by the `turn/start` event. */
  turn: number;
  /** When that turn started (ISO), when the log records it. */
  startedAt: string;
  /** Milliseconds since the session's last event; 0 when unknown. */
  quietMs: number;
}
/**
 * Find every session with an open turn.
 * @param sessions - live sessions as `{ id, events }` (events in log order).
 * @param now - current epoch milliseconds, injected so the result is testable.
 * @returns one entry per generating session, in input order.
 */
declare function findOpenTurns(sessions: readonly SessionView[], now: number): OpenTurn[];
//#endregion
//#region src/core/status.d.ts
/** Result class of the launcher's tiered probe (see renderProbeFunctions). */
type ProbeClass = 'up-dsh' | 'up-unknown' | 'port-no-response' | 'down';
/** What the probe observed on the configured port. */
interface ProbeInfo {
  class: ProbeClass;
  /** HTTP status of the classifier request, when one answered. */
  status?: number;
  /** True when the port answers DSH but the browser needs the token URL. */
  authRequired?: boolean;
  checkedAt: string;
}
/** Occupant of the configured port. */
interface PortOwnerInfo {
  listening: boolean;
  ownerPid?: number;
  ownerName?: string;
  ownerPath?: string;
  /** True when the occupant is this host process (the normal case). */
  isSelf?: boolean;
}
/** The spawned `dsh web` child, if one was started. */
interface ChildInfo {
  pid?: number;
  exitCode?: number | null;
  outLog?: string;
  errLog?: string;
  /** Tail of the captured stdout/stderr — the whole point of v0.2 diagnostics. */
  tail?: string;
}
/** Single-instance guard state. */
interface MutexInfo {
  acquired: boolean;
  waitedForExisting: boolean;
}
/**
 * Launcher run outcome. The lifecycle values (`invoked`, `spawned`) are
 * progress markers; the rest double as the failure taxonomy the GUI renders.
 */
type LauncherPhase = 'invoked' | 'mutex-held' | 'spawned' | 'ready' | 'up-dsh' | 'up-unknown' | 'port-no-response' | 'down' | 'dsh-not-found' | 'child-exit' | 'timeout-alive' | 'timeout-dead' | 'error';
/** `launcher-status.json` — written by the generated launcher script. */
interface LauncherStatus {
  schema: 1;
  updatedAt: string;
  phase: LauncherPhase;
  probe?: ProbeInfo;
  port?: PortOwnerInfo;
  child?: ChildInfo;
  mutex?: MutexInfo;
  /** Human-readable conclusion (Chinese: it also feeds the desktop message box). */
  message: string;
  /** Suggested next step, shown alongside the message. */
  hint?: string;
}
/** `restart-status.json` — written by the host at handoff and by the helper. */
type RestartPhase = 'handoff' | 'verifying-old' | 'killing' | 'spawning' | 'ready' | 'timeout' | 'failed' | 'aborted-busy';
/** One process the fallback killer had to stop. */
interface KilledProcess {
  pid: number;
  name?: string;
  reason: string;
}
/** The replacement `dsh web` process. */
interface SpawnedProcess {
  pid?: number;
  command?: string;
  args?: string[];
}
/** Proof the new instance is the one that answered after the handoff. */
interface RestartReady {
  instanceId?: string;
  pid?: number;
  waitedMs?: number;
}
/** Whether any session currently has a turn open — i.e. is generating. */
interface BusySnapshot {
  /**
   * False when the check itself could not run (sessions service missing or its
   * API changed). The host then fails OPEN and records `check`, because a
   * fail-closed check would disable restart forever.
   */
  known: boolean;
  check: string;
  generating: boolean;
  openTurns: OpenTurn[];
  checkedAt: string;
}
interface RestartStatus {
  schema: 1;
  updatedAt: string;
  phase: RestartPhase;
  /** Identity of the instance that requested the restart. */
  instanceIdBefore?: string;
  hostPid?: number;
  helperPid?: number;
  helperMethod?: 'detached' | 'schtasks';
  busyCheck?: string;
  busyAtHandoff?: BusySnapshot;
  /** True when the user overrode the busy guard after an explicit confirmation. */
  forced?: boolean;
  killed?: KilledProcess[];
  spawned?: SpawnedProcess;
  ready?: RestartReady;
  /** Token URL printed by the new instance, for when the cookie is gone. */
  authUrl?: string;
  childTail?: string;
  error?: string;
  hint?: string;
}
type StatusFile = LauncherStatus | RestartStatus;
type ParseResult = {
  ok: true;
  value: StatusFile;
} | {
  ok: false;
  error: string;
};
/** Strip a UTF-8 BOM; PowerShell 5.1 loves to add one. */
declare function stripBom(text: string): string;
/**
 * Parse a status file tolerantly. Only the fields the two halves depend on are
 * validated (`schema`, `updatedAt`, `phase`); everything else passes through so
 * a newer writer does not break an older reader.
 * @param text - raw file contents.
 * @returns the parsed object, or a reason it could not be used.
 */
declare function parseStatusFile(text: string): ParseResult;
/**
 * Last `n` lines of a log, for the GUI panel and the desktop message box.
 * @param text - raw log contents (may be empty).
 * @param n - how many trailing lines to keep.
 * @returns the tail, without a trailing newline.
 */
declare function tailLines(text: string, n: number): string;
/** Severity of one phase, used for badges and the one-time startup banner. */
type PhaseSeverity = 'ok' | 'info' | 'warn' | 'error';
/**
 * Map either phase enum onto a severity. `aborted-busy` is an intentional
 * cancellation, not a failure, so it stays a warning.
 * @param phase - launcher or restart phase.
 * @returns the severity the GUI should render.
 */
declare function phaseSeverity(phase: string): PhaseSeverity;
/** True when the launcher phase means "the icon failed to start DSH". */
declare function isLauncherFailure(phase: string): boolean;
/**
 * Short human duration: `820ms`, `12.4s`, `1m 03s`.
 * @param ms - duration in milliseconds.
 * @returns the formatted duration.
 */
declare function formatDuration(ms: number): string;
//#endregion
//#region src/index.d.ts
/** Stable cordis plugin name. */
declare const name = "dsh-desktop_quick_launcher";
/** Host services this plugin consumes. `sessions` is read optionally at runtime. */
declare const inject: string[];
/** Wire contract between host routes and the browser API helpers. */
declare const LAUNCHER_API: {
  /** Instance identity + nonce. */
  readonly ping: "/api/dsh-desktop_quick_launcher/ping";
  /** Full status snapshot (instance, busy, reports, logs). */
  readonly status: "/api/dsh-desktop_quick_launcher/status";
  /** Create (or refresh) the desktop icon. */
  readonly create: "/api/dsh-desktop_quick_launcher/create";
  /** Hand over to the restart helper and exit. */
  readonly restart: "/api/dsh-desktop_quick_launcher/restart";
  /** Request the host process to exit gracefully. */
  readonly shutdown: "/api/dsh-desktop_quick_launcher/shutdown";
  /** List the plugin's own log/status files. */
  readonly logs: "/api/dsh-desktop_quick_launcher/logs";
  /** Truncate log files (or delete status files). */
  readonly logsClear: "/api/dsh-desktop_quick_launcher/logs/clear";
  /** Reveal the log directory in the file manager. */
  readonly logsOpen: "/api/dsh-desktop_quick_launcher/logs/open";
};
/** Nonce header required by every state-changing route. */
declare const NONCE_HEADER = "x-dsh-ql-nonce";
/** Plugin version, mirrored from package.json by hand. */
declare const PLUGIN_VERSION = "0.2.2";
/** Result of a desktop-icon creation. */
interface CreateResult {
  ok: true;
  /** Absolute path of the icon on the Desktop. */
  path: string;
  /** Platform the icon was generated for. */
  platform: LauncherPlatform;
  /** Non-fatal notice (e.g. dsh missing from PATH). */
  warning?: string;
}
/** Plugin config, validated by the same-named schemastery schema. */
interface Config {
  /** Master switch for the model-facing guidance section. */
  enabled?: boolean;
  /** When true, a system-prompt section announces the plugin to the agent. */
  announceToAgent?: boolean;
  /** Command that starts dsh (must be on PATH when the launcher runs). */
  dshCommand?: string;
  /** Base URL of the dsh web GUI. */
  url?: string;
  /** Optional profile started as `dsh --profile <profile> --no-open`. */
  profile?: string;
  /** Optional icon file (.ico/.png) for the desktop icon; empty uses the bundled dsh icon. */
  iconPath?: string;
  /** Whether the shutdown control asks for confirmation before exiting. */
  confirmShutdown?: boolean;
  /** Grace period between the restart acknowledgement and the host exiting. */
  restartGraceMs?: number;
  /** Readiness budget for the restart helper, in seconds. */
  restartTimeoutSec?: number;
  /**
   * `block` (default) refuses a restart while a turn is open. `warn` only
   * reports it.
   */
  busyPolicy?: string;
  /**
   * Survivor mechanism: `auto` (default) prefers a scheduled task and falls back
   * to a detached child, `schtasks` pins the scheduled task, `detached` pins the
   * detached child. The scheduled task wins because a detached child is
   * routinely killed together with the host's process tree — verified on
   * Windows, where the detached helper never even executed.
   */
  restartMethod?: string;
  /** How long to wait for the helper to start working before cancelling. */
  helperStartTimeoutMs?: number;
  /** Show the desktop-icon/details button in the floating panel. */
  showDetailsButton?: boolean;
  /** Show the stop button in the floating panel. */
  showStopButton?: boolean;
  /** Show the restart button in the floating panel. */
  showRestartButton?: boolean;
  /** Show the last launcher report as a banner when the GUI loads. */
  showLaunchReport?: boolean;
}
declare const Config: z<Config>;
/** The dsh launcher provides ctx.appExit via @deepseek-ai/dsh-cmdline. Spelled locally. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Bounded process-exit request provided by the dsh launcher. */
    appExit?: (code: number) => void;
  }
}
/** Write the launcher script + place the desktop icon for the current platform. */
declare function createDesktopShortcut(specSource: () => LauncherSpec): Promise<CreateResult>;
/**
 * Optional dependency injection for `apply`.
 *
 * Production never passes these. The test suite uses them to exercise the
 * restart handover (202 body, status file, helper script, inflight marker, and
 * the pre-exit busy re-check) without spawning a real helper or exiting the test
 * runner.
 */
interface ApplyHooks {
  /** Replace the survivor spawn. */
  spawnSurvivor?: (helperPath: string) => Promise<{
    pid: number;
    method: 'detached' | 'schtasks';
  }>;
  /** Replace the exit request. */
  requestExit?: (code: number) => void;
}
/**
 * Mount the routes, the settings section, and the (optional) system-prompt
 * section.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config.
 * @param hooks - test-only overrides for the spawn/exit side effects.
 */
declare function apply(ctx: Context, config?: Config, hooks?: ApplyHooks): void;
//#endregion
export { ApplyHooks, type BusySnapshot, type ChildInfo, Config, CreateResult, type KilledProcess, LAUNCHER_API, type LauncherPhase, type LauncherPlatform, type LauncherSpec, type LauncherStatus, type MutexInfo, NONCE_HEADER, type OpenTurn, PLUGIN_VERSION, type PortOwnerInfo, type ProbeClass, type ProbeInfo, type RestartPhase, type RestartSpec, type RestartStatus, type SessionEventLike, type SessionView, type StatusFile, apply, createDesktopShortcut, findOpenTurns, formatDuration, inject, isLauncherFailure, name, parseStatusFile, phaseSeverity, portFromUrl, renderLauncherScript, renderRestartHelper, renderScheduledTaskCommand, resolveLauncherSpec, stripBom, tailLines };