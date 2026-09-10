<h1 align="center">dsh-desktop_quick_launcher</h1>

<p align="center"><strong>English</strong> · <a href="./README.zh.md">简体中文</a></p>

<p align="center"><strong>Desktop quick launch, one-click restart, and graceful exit for dsh web — without ever cutting off an answer that is still generating.</strong> Rebuilt as an independent, Apache-2.0 plugin from the retired <code>@linxin666/dsh-desktop-launcher</code>.</p>

<p align="center">
  <a href="https://github.com/KLucen/dsh-desktop_quick_launcher"><strong>GitHub</strong></a> ·
  <a href="#what-it-is">What it is</a> ·
  <a href="#restarting-safely">Restarting safely</a> ·
  <a href="#failure-diagnostics">Diagnostics</a> ·
  <a href="#install">Install</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

## What it is

A dual-face (Host + Client) DSH Web plugin that fills the three ergonomic gaps of a
local-first server: a **double-click desktop icon** that starts the server and opens the
Web GUI, a **one-click restart** that survives the host's own death, and a **one-click
exit** — all of them refusing to interrupt a running answer.

### Desktop icon (Host)

`POST /api/dsh-desktop_quick_launcher/create` writes a launcher script under
`<dsh-home>/desktop-quick-launcher/` and places a desktop icon — Windows `.lnk` / macOS
`.command` / Linux `.desktop` (the bundled dsh icon is copied next to the script so the
shortcut keeps working even if the package moves).

- A **tiered probe** decides what to do: TCP connect → plugin `/ping` (this plugin, with
  the instance id) → `GET /` fingerprint (`dsh web authentication required`) → foreign.
  So "DSH is already up", "some other program holds the port", "something accepts TCP but
  never answers (stuck instance)" and "port is free" are four distinct, reported outcomes
  instead of one "not ready".
- A **named mutex** serializes concurrent invocations: triple-clicking the icon no longer
  races three launchers into port 3080.
- It starts `dsh web --no-open` hidden with `-RedirectStandardOutput`/`-RedirectStandardError`,
  polls to readiness (**150 s** budget), then opens the browser with three fallbacks
  (`Start-Process` → `explorer.exe` → `cmd /c start`).
- Anything **except** a free port is a diagnosis, not a spawn: the launcher reports the
  occupying PID and process name and stops.

### Floating panel (Client)

Bottom-right of the page: **desktop icon / details**, **stop**, **restart**.

- **Details** opens a popover with the live instance (PID, port, uptime, version), the
  current generation state, the **last launcher report**, the **last restart report**, and
  the captured child output tail.
- **Stop** asks for confirmation, then the host exits gracefully after flushing the
  response; the page closes itself.
- **Restart** hands over to a detached helper and reloads the page back into the same
  session once the new instance answers.

### Settings card

The plugin contributes its own page to **Settings** (the `settings.section` slot, next to the
other plugin pages):

- **Floating buttons** — three independent switches for the details, stop, and restart
  buttons. Hide one, two, or all three (hiding all three removes the floating panel
  entirely). The flags are ordinary plugin settings in the `desktop-quick-launcher`
  namespace, so they persist in the profile settings file and can equally be edited from the
  generic plugin-config editor.
- **Logs and status files** — the card lists `launcher.log`, `restart-helper.log`,
  `dsh-child.out.log`, `dsh-child.err.log`, `launcher-status.json`, `restart-status.json`
  and `restart-inflight.json` with size and modification time, and offers **View** (tail),
  **Clear** (per file or all), **Refresh**, and **Open folder**. Status files are deleted
  rather than emptied, so the panel reports "nothing recorded yet" instead of a parse error.
  The routes accept only these whitelisted names — never a caller-supplied path — and the
  write side requires the nonce.

### Restarting safely

The reason restart deserves its own section: restarting `dsh web` is the most common thing
you do to it (install a plugin, upgrade the core, re-apply a patch), and the naive version
of it is destructive.

- **A turn that is still open blocks the restart.** The host reads the live sessions,
  applies `@deepseek-ai/dsh-session`'s own open-turn rule (the last `turn/start` / `turn/end`
  boundary decides), and answers `409 busy` with the offending session ids. Both stop and
  restart are gated; the panel disables both buttons while generating and offers
  **"restart when idle"** instead (client-side queue, 10 min cap, cancellable).
- **A turn that starts during the handover cancels the restart.** The host re-checks right
  before exiting; if an answer began in the meantime it writes `aborted-busy` and stays
  alive. The page reports "cancelled: a new answer had started".
- **The escape hatch is deliberate.** If a turn hangs forever, a hard block would make the
  restart button permanently useless, so `force: true` exists — reachable only through a
  second, explicitly worded confirmation ("force: this interrupts the answer"), and recorded
  as `forced: true` in the restart report.
- **The helper outlives the host — and proves it before the host dares to exit.** The host starts
  the helper as a **scheduled task** (its process belongs to the Task Scheduler service, so the
  host's own teardown cannot take it down), waits until the helper moves the shared status file
  past `handoff`, and only then answers `202` and exits. If the helper never reports in, the
  restart is **cancelled and the service keeps running** — a broken survivor mechanism can no
  longer leave you with a dead server. `restartMethod: detached` pins the fallback (a plain
  detached child), which is measurably less reliable: on Windows it was observed to be killed
  together with the host's process tree *before executing a single statement*.
  The helper waits out the grace period, verifies the old instance is gone, restores the working
  directory and `DSH_HOME` (a scheduled task starts in `%SystemRoot%\System32` with no
  `DSH_HOME`, so both must be restored explicitly), starts the replacement, and parses the new
  instance's `dsh web: http://…/?token=…` line from the captured stdout (useful if your browser
  cookie ever expires — see limitations). It **never** uses `taskkill /T`, because the helper is a
  descendant of the old host and `/T` would kill the helper itself.
- **Why the page can come back by itself:** the browser session cookie is signed with a
  secret persisted in `$DSH_HOME/.credentials.yaml` (30-day default), so it survives a
  restart. The client waits for a `/ping` whose `instanceId` differs from the previous one,
  then reloads the same URL.
- **Only one restart at a time:** an in-flight marker makes a second request answer
  `409 restart-inflight` (double-clicked tabs cannot start two helpers).

### Failure diagnostics

- The child's stdout/stderr are captured to `dsh-child.out.log` / `dsh-child.err.log`, and
  the **last 15 lines** land in both the desktop message box and the report. (v0.1 ran the
  child with `-WindowStyle Hidden` and discarded everything, so "exited with code 1" had no
  reason attached.)
- Every run writes `launcher-status.json` atomically (temp + rename, UTF-8 **without** BOM);
  a restart writes `restart-status.json`. Both are read back by `GET /status`.
- The GUI shows the **last launcher failure once, on load**, as a banner — you no longer
  have to know that a log file exists.
- Nine classified failure kinds (`dsh-not-found`, `up-unknown`, `port-no-response`,
  `child-exit`, `timeout-alive`, `timeout-dead`, `mutex-held`, `up-dsh`, `error`), each with
  a suggested next step.

### Safety boundaries

All routes are **loopback-only** (socket address + Host header + `sec-fetch-site` +
Origin), which matters because DSH serves plugin routes *outside* the browser login gate.
Every state-changing route additionally requires a per-instance **nonce** issued by
`GET /ping` and sent as `x-dsh-ql-nonce`; without it the answer is
`403 nonce-required`. This stops a cross-site page from blindly POSTing to `127.0.0.1` — it
does **not** stop a local process, which can read `/ping` itself.

> Note: `/ping` and `/status` are readable without credentials; `/create`, `/restart` and
> `/shutdown` are not actionable without the nonce.

### API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/dsh-desktop_quick_launcher/ping` | GET | instance id, nonce, pid, port, uptime |
| `/api/dsh-desktop_quick_launcher/status` | GET | instance + `busy` + last launch/restart reports + log paths |
| `/api/dsh-desktop_quick_launcher/create` | POST | write the launcher script + desktop icon |
| `/api/dsh-desktop_quick_launcher/restart` | POST | hand over to the detached helper, then exit (`409 busy` / `409 restart-inflight`) |
| `/api/dsh-desktop_quick_launcher/shutdown` | POST | exit gracefully (`409 busy`) |
| `/api/dsh-desktop_quick_launcher/logs` | GET | list the plugin's log/status files, or read one (`?name=&tail=`) |
| `/api/dsh-desktop_quick_launcher/logs/clear` | POST | truncate logs / delete status files (`names` whitelist) |
| `/api/dsh-desktop_quick_launcher/logs/open` | POST | reveal the log directory in the file manager |

### Settings

A schemastery section (`desktop-quick-launcher` namespace): `enabled`, `announceToAgent`,
`dshCommand`, `url`, `profile`, `iconPath`, `confirmShutdown`, `restartGraceMs` (1500),
`restartTimeoutSec` (150), `busyPolicy` (`block` | `warn`), `restartMethod`
(`auto` | `schtasks` | `detached`), `helperStartTimeoutMs` (8000), `showDetailsButton`,
`showStopButton`, `showRestartButton`, `showLaunchReport`.

### Client bundle that actually loads

DSH's browser loader requires every plugin's `./client` entry to be a classic script that
self-registers via `window.__ModuleLoader__.load({ id, factory })` (react/react-dom are
injected through the loader's `require`). `pnpm build` therefore produces `lib/client.js`
through an esbuild wrap step (`scripts/wrap-client.mjs`) and validates it in a VM
(`scripts/verify-client.mjs`). A plain ESM `client.mjs` will abort `dsh web` boot with
`loaded without registering ... via ModuleLoader.load` — see Troubleshooting.

## Install

> Not yet published to npm — install from GitHub.

**DSH Web CLI, from GitHub (recommended):**

```bash
dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher
# Restart dsh web (the panel's restart button works too, once installed)
```

**On networks where `github.com` is unreachable (e.g. mainland China), use the mirror:**

```bash
dsh plugin --profile web add "https://gh-proxy.com/https://codeload.github.com/KLucen/dsh-desktop_quick_launcher/tar.gz/refs/heads/main"
```

**From the repository (development):**

```bash
git clone git@github.com:KLucen/dsh-desktop_quick_launcher.git   # or the mirror above
cd dsh-desktop_quick_launcher
pnpm install
pnpm typecheck && pnpm test      # builds, then runs the unit + host integration suite
dsh plugin --profile web add link:D:\path\to\dsh-desktop_quick_launcher
# Restart dsh web for the plugin to take effect
```

**Local debug with `--patch`** (temporary mount for one boot — the package must already be
linked into the profile's `node_modules`). `--patch` is a **launcher-level** flag, so it
must precede the web app's own flags:

```bash
dsh --profile web --patch D:\path\to\dsh-desktop_quick_launcher\cordis.patch.yml --no-open
```

## Manual upgrade

When you upgrade by bumping the version/commit in the profile `package.json` and running
`pnpm install`, the top-level `node_modules/dsh-desktop_quick_launcher` entry is not always
refreshed — it can stay linked to the previous version's store directory until recreated.

1. Remove the stale entry: `dsh plugin --profile web remove dsh-desktop_quick_launcher`
   (or delete `node_modules/dsh-desktop_quick_launcher`).
2. Re-add from GitHub (`dsh plugin --profile web add ...` above).
3. Verify the entry ships `lib/client.js` (wrapped classic script) and `lib/index.mjs`,
   then restart `dsh web`.

Upgrading from **0.1.x** also means regenerating the desktop icon (the panel's icon button):
the launcher script format changed, and pulling a fresh `launcher.ps1` is what enables the
tiered probe, the mutex, and the captured child output.

## Troubleshooting

**"Failed to load plugins ... loaded without registering 'dsh-desktop_quick_launcher' via ModuleLoader.load" (DSH web aborts on the plugin screen)**

The installed copy's `./client` entry is a plain ESM bundle or a hand-patched file without
the registration call. The repository fix (≥ commit `bcfaf9d`) builds the client as a
classic script that calls `window.__ModuleLoader__.load`; a hand-written wrapper written
through PowerShell also mangles UTF-8 (mojibake UI text), so prefer rebuilding from source:

- Pull/rebuild the repo (`pnpm install && pnpm build`), reinstall from GitHub as above, and
  restart `dsh web`.
- Quick self-check: the file at `node_modules/dsh-desktop_quick_launcher/lib/client.js`
  must start with `window.__ModuleLoader__.load({` and show clean Chinese in the strings.

**"I installed from GitHub but nothing appears in the Web UI"**

- Restart `dsh web` fully after installing (client bundles load at boot).
- Confirm the package name `dsh-desktop_quick_launcher` is present under
  `dsh.profile.bundles` in the profile's `package.json`; add it if missing.
- Confirm the bottom-right buttons did not mount under another overlay; check the browser
  console for a `ModuleLoader` error mentioning the id.

**"Restart/stop is greyed out" or "409 busy"**

That is the plugin working as intended: a session has an unfinished turn, so an answer is
being generated. Wait for it, use **"restart when idle"**, or (only if the turn is truly
stuck) confirm the explicitly-worded force dialog. `GET /status` names the sessions under
`busy.openTurns`.

**"409 restart-inflight"**

A restart is already in progress; the marker lives for 90 s. If a previous helper died
mid-flight, wait for the marker to expire or delete
`<dsh-home>/desktop-quick-launcher/restart-inflight.json`.

**"403 nonce-required" when calling the API with curl**

Fetch `GET /api/dsh-desktop_quick_launcher/ping` first and replay its `nonce` in the
`x-dsh-ql-nonce` header; the nonce is per instance and rotates on every restart.

**"The desktop icon starts dsh web but the browser does not open"**

- The launcher now **reports why** instead of guessing: read `launcher-status.json`
  (`phase`, `port.ownerName`, `child.exitCode`, `child.tail`) in
  `<dsh-home>/desktop-quick-launcher/`, or open the panel's **Details** popover — the same
  report is shown there, and a failure is announced once on the next GUI load.
- `phase: "up-unknown"` means something else owns the port — the occupying PID and process
  name are in the report. Free it, or point `url` at another port.
- `phase: "child-exit"` comes with the last 15 lines of the child's stderr; that is usually
  the whole answer.
- Do not double-click the icon repeatedly while a first boot is still running: the mutex
  makes the extra invocations *wait* instead of spawning a doomed second server, but they
  will still hold a console open until the first boot is ready.

**"The launcher shows no last-launch report"**

The report comes from `launcher-status.json`, which only the **v0.2 launcher script** writes.
If your desktop shortcut was created by an earlier version, it still runs that older script and
nothing is recorded. Click the panel's **icon button** (or the settings card's Refresh/Open
folder) once to regenerate `launcher.ps1`; the next double-click then produces a full report.
The placeholder text in the panel reads "（暂无记录）" / "(nothing recorded yet)" in that state.

**"The page did not come back after a restart"**

- **v0.2.0 and earlier could do exactly this** (the handover helper was started as a detached
  child, which Windows killed with the host's process tree, so the host exited and nothing
  replaced it — `restart-status.json` stayed at `phase: "handoff"` and no `restart-helper.log`
  appeared). Fixed in **v0.2.1**: the helper now goes through a scheduled task, and the host
  refuses to exit until the helper has reported in, cancelling the restart otherwise.
  Recover a stranded service with the desktop icon, or `dsh web` in a terminal.
- `restart-status.json` records the outcome (`ready` / `timeout` / `failed` /
  `aborted-busy`) plus the new instance's token URL; the panel shows it under **Details**.
- If your browser asks for authentication, open the `authUrl` from that report — the cookie
  outlives a restart by default, but it is not eternal.

## Known limitations

- Restart and exit stop the whole `dsh web` process: sessions persist and can be resumed,
  but the currently generating answer is never kept — which is exactly why the plugin
  refuses to do it while a turn is open.
- The busy check reads the live session store. If that service is missing or its API
  changes, the check **fails open** (the restart is allowed, with the reason recorded in
  `busyCheck`) — a fail-closed check would disable restart forever.
- `busyPolicy: warn` restores the v0.1 behaviour of only reporting the generating state.
- The nonce stops cross-site browser requests, not a local process.
- All routes are loopback-only by design; they do not work over a remote browser connection
  to a LAN-exposed server.
- The generated Windows icon is named `DSH-Web.lnk` and overwrites any same-named shortcut
  on the Desktop when you click "create/refresh".
- The Windows restart helper is a PowerShell script launched through a scheduled task: on
  locked-down machines where scheduled tasks are blocked, set `restartMethod: detached` (less
  reliable) or restart manually.
- `restartMethod: detached` runs the helper as an ordinary detached child. On Windows that child
  can be killed together with the host's process tree, in which case the start-gate cancels the
  restart and keeps the service alive instead of leaving it down.
- POSIX launchers (macOS `.command`, Linux `.sh`/`.desktop`) are generated from the same
  template but were developed and verified on Windows; the restart helper is Windows-only
  (on POSIX, restart falls back to the host's own exit plus a manual start).
- The plugin is not on npm yet; installs use the GitHub tarball above (branch `main`).
- SDK dependencies are pinned to the `@deepseek-ai/* 0.1.2-rc.1` line and follow the DSH
  release cadence; `dsh.engines` declares `>= 0.1.2-alpha.4`.

## Development

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # builds, then: unit tests, generated-PowerShell parse check, host integration tests
```

The test suite mounts the real host half against a stub cordis context and drives the real
route handlers, with the helper spawn and the process exit injected (`ApplyHooks`) and
`DSH_HOME` redirected to a temp directory — so it never spawns a helper, never exits the
runner, and never touches your real profile or Desktop.

## License

Apache-2.0 — derived from [@linxin666/dsh-desktop-launcher](https://www.npmjs.com/package/@linxin666/dsh-desktop-launcher); see `NOTICE` and `LICENSE`.
