<h1 align="center">dsh-desktop_quick_launcher</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh.md">简体中文</a></p>

<p align="center"><strong>Desktop quick launch + one-click graceful exit for dsh web.</strong> Rebuilt as an independent, Apache-2.0 plugin from the retired <code>@linxin666/dsh-desktop-launcher</code>.</p>

<p align="center">
  <a href="https://github.com/KLucen/dsh-desktop_quick_launcher"><strong>GitHub</strong></a> ·
  <a href="#what-it-is">What it is</a> ·
  <a href="#install">Install</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

## What it is

A dual-face (Host + Client) DSH Web plugin that gives `dsh web` the two ergonomics a
local-first server is missing: a **double-click desktop icon** that starts the server and
opens the Web GUI, and a **one-click exit** from inside the GUI.

**Desktop icon (Host, `/api/dsh-desktop_quick_launcher/create`):** writes a launcher
script under `<dsh-home>/desktop-quick-launcher/` and places a desktop icon — Windows
`.lnk` / macOS `.command` / Linux `.desktop` (the bundled dsh icon is copied next to the
script so the shortcut keeps working even if the package moves).

- The generated launcher first probes the GUI URL: already running → open the browser
  and exit; otherwise it starts `dsh web --no-open` hidden and polls until the GUI
  answers (**150 s** budget).
- Browser opening has three fallbacks — `Start-Process` → `explorer.exe` → `cmd /c
  start` — so "started but no browser" is effectively eliminated.
- Every step is written to `launcher.log` next to the script (invoked / found dsh /
  spawned pid / early child exit / ready / each open attempt / timeout), so a failure is
  diagnosable from one file instead of guesswork.

**Floating exit control (Client):** a small circular power button pinned to the
bottom-right of the page. Clicking it opens a **custom confirmation dialog** (not the
native `confirm`); confirming POSTs `/api/dsh-desktop_quick_launcher/shutdown`, which
asks the host process to exit gracefully (`ctx.appExit` provided by the dsh launcher,
`process.exit(0)` fallback) after the response is flushed, then the page closes itself.
A second small button creates/refreshes the desktop icon with an inline toast result.

**Safety boundaries:** both routes are **loopback-only** (socket address + Host header +
same-origin markers), so a LAN-exposed `dsh web` deployment cannot be icon-created or
shut down remotely. Settings are exposed through a schemastery section
(`desktop-quick-launcher` namespace) — `enabled`, `announceToAgent`, `dshCommand`,
`url`, `profile`, `iconPath`, `confirmShutdown`.

**Client bundle that actually loads:** DSH's browser loader requires every plugin's
`./client` entry to be a classic script that self-registers via
`window.__ModuleLoader__.load({ id, factory })` (react/react-dom are injected through
the loader's `require`). `pnpm build` therefore produces `lib/client.js` through an
esbuild wrap step (`scripts/wrap-client.mjs`) and validates it in a VM
(`scripts/verify-client.mjs`). A plain ESM `client.mjs` will abort `dsh web` boot with
`loaded without registering ... via ModuleLoader.load` — see Troubleshooting.

**Host surface:** cordis plugin `dsh-desktop_quick_launcher` injecting
`webServer`/`systemPrompt`, registered through `cordis.patch.yml`; the Host half ships
as ESM (`lib/index.mjs`) and the browser half as the wrapped classic script above.

## Install

> Not yet published to npm — install from GitHub.

**DSH Web CLI, from GitHub (recommended):**

```bash
dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher
# Restart dsh web
dsh web
```

**On networks where `github.com` is unreachable (e.g. mainland China), use the mirror:**

```bash
dsh plugin --profile web add "https://gh-proxy.com/https://codeload.github.com/KLucen/dsh-desktop_quick_launcher/tar.gz/refs/heads/main"
```

**From the repository (development):**

```bash
git clone git@github.com:KLucen/dsh-desktop_quick_launcher.git   # or the mirror above
cd dsh-desktop_quick_launcher
pnpm install && pnpm build        # typecheck + tsdown + wrap-client + verify-client
dsh plugin --profile web add link:D:\path\to\dsh-desktop_quick_launcher
# Restart dsh web (or DSH Desktop) for the plugin to take effect
```

**Local debug with `--patch`** (temporary mount for one boot — the package must already
be linked into the profile's node_modules):

```bash
dsh web --patch D:\path\to\dsh-desktop_quick_launcher\cordis.patch.yml
```

## Manual upgrade

When you upgrade by bumping the version/commit in the profile `package.json` and running
`pnpm install`, the top-level `node_modules/dsh-desktop_quick_launcher` entry is not
always refreshed — it can stay linked to the previous version's store directory until
recreated.

1. Remove the stale entry: `dsh plugin --profile web remove dsh-desktop_quick_launcher`
   (or delete `node_modules/dsh-desktop_quick_launcher`).
2. Re-add from GitHub (`dsh plugin --profile web add ...` above).
3. Verify the entry ships `lib/client.js` (wrapped classic script) and
   `lib/index.mjs`, then restart `dsh web`.

## Troubleshooting

**"Failed to load plugins ... loaded without registering 'dsh-desktop_quick_launcher' via ModuleLoader.load" (DSH web aborts on the plugin screen)**

The installed copy's `./client` entry is a plain ESM bundle or a hand-patched file
without the registration call. The repository fix (≥ commit `bcfaf9d`) builds the client
as a classic script that calls `window.__ModuleLoader__.load`; a hand-written wrapper
written through PowerShell also mangles UTF-8 (mojibake UI text), so prefer rebuilding
from source:

- Pull/rebuild the repo (`pnpm install && pnpm build`), reinstall from GitHub as above,
  and restart `dsh web`.
- Quick self-check: the file at `node_modules/dsh-desktop_quick_launcher/lib/client.js`
  must start with `window.__ModuleLoader__.load({` and show clean Chinese in the strings.

**"I installed from GitHub but nothing appears in the Web UI"**

- Restart `dsh web` fully after installing (client bundles load at boot).
- Confirm the package name `dsh-desktop_quick_launcher` is present under
  `dsh.profile.bundles` in the profile's `package.json`; add it if missing.
- Confirm the bottom-right buttons did not mount under another overlay; check the
  browser console for a `ModuleLoader` error mentioning the id.

**"The desktop icon starts dsh web but the browser does not open"**

- Open the `launcher.log` that the generated script writes next to itself. It records
  whether the service became ready and which open attempt (if any) failed.
- Do not double-click the icon repeatedly while a first boot is still running — several
  launcher instances each spawn a `dsh web`, and the second instance exits because port
  3080 is already taken (the launcher reports "DSH 进程启动后退出"). Wait for the first
  boot (up to 150 s) or stop the stale instance first.

## Known limitations

- The exit control stops the whole `dsh web` process: running sessions/tasks in the
  current host are interrupted (sessions persist and can be resumed after restart).
- `/create` and `/shutdown` are loopback-only by design; they do not work over a remote
  browser connection to a LAN-exposed server.
- The generated Windows icon is named `DSH-Web.lnk` and overwrites any same-named
  shortcut on the Desktop when you click "create/refresh".
- POSIX launchers (macOS `.command`, Linux `.sh`/`.desktop`) are generated from the same
  template but were developed and verified on Windows; report issues with the
  `launcher.log`/terminal output attached.
- The plugin is not on npm yet; installs use the GitHub tarball above (branch `main`).
- SDK dependencies are pinned to the `@deepseek-ai/* 0.1.2-rc.1` line and follow the DSH
  release cadence; `dsh.engines` declares `>= 0.1.2-alpha.4`.

## License

Apache-2.0 — derived from [@linxin666/dsh-desktop-launcher](https://www.npmjs.com/package/@linxin666/dsh-desktop-launcher); see `NOTICE` and `LICENSE`.
