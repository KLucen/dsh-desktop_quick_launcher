import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/core/launcher.d.ts
/**
 * Pure launcher generation — migrated from @linxin666/dsh-desktop-launcher
 * (src/core/launcher.ts, Apache-2.0). Produces the PowerShell / POSIX launcher
 * bodies, the Windows shortcut installer, and the desktop file names for the
 * three supported platforms. No filesystem or process access: everything here
 * is testable without touching disk.
 *
 * Adaptations vs. the retired upstream:
 *  - The PowerShell body no longer renders the WPF startup popup (its
 *    `Start-Process $url` open step proved unreliable on some Windows hosts).
 *    The replacement polls with logging (launcher.log next to the script),
 *    opens the browser with two fallbacks, waits up to 120 s, and surfaces
 *    failures in a plain message box.
 */
/** Desktop platforms the launcher can generate an icon for. */
type LauncherPlatform = 'win32' | 'darwin' | 'linux';
/** Launcher behavior, resolved from plugin config. */
interface LauncherSpec {
  /** Command that starts dsh (must be on PATH when the launcher runs). */
  dshCommand: string;
  /** Base URL of the dsh web GUI. */
  url: string;
  /** Optional profile started as `dsh --profile <profile> --no-open`. */
  profile?: string;
  /** Optional icon file (.ico/.png); empty uses the bundled dsh icon. */
  iconPath?: string;
}
/** Render the launcher script for one platform. */
declare function renderLauncherScript(platform: LauncherPlatform, spec: LauncherSpec): string;
//#endregion
//#region src/index.d.ts
/** Stable cordis plugin name. */
declare const name = "dsh-desktop_quick_launcher";
/** Host services this plugin consumes. */
declare const inject: string[];
/** Wire contract between host routes and the browser API helpers. */
declare const LAUNCHER_API: {
  /** Create (or refresh) the desktop icon. */
  readonly create: "/api/dsh-desktop_quick_launcher/create";
  /** Request the host process to exit gracefully. */
  readonly shutdown: "/api/dsh-desktop_quick_launcher/shutdown";
};
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
 * Mount the routes, the shutdown surface, the settings section, and the
 * (optional) system-prompt section.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, CreateResult, LAUNCHER_API, apply, createDesktopShortcut, inject, name, renderLauncherScript };