# dsh-desktop_quick_launcher

DSH Web plugin: **desktop quick launch + one-click graceful exit** (independent
rebuild of the retired `@linxin666/dsh-desktop-launcher`, Apache-2.0).

Repo: https://github.com/KLucen/dsh-desktop_quick_launcher

- Bottom-right circular **power button** → custom confirm dialog → graceful host
  exit (`ctx.appExit`; `process.exit(0)` fallback).
- Adjacent blue button creates/refreshes the desktop launcher icon.
- Generated icon starts `dsh web --no-open`, polls up to **150 s**, then opens
  the browser (3 fallbacks: `Start-Process` → `explorer.exe` → `cmd /c start`).
- Launcher writes a full `launcher.log` next to itself for diagnosis.
- Host routes `/api/dsh-desktop_quick_launcher/create|shutdown` are
  loopback-only.

Build: `pnpm install && pnpm typecheck && pnpm build` (→ `lib/*.mjs`).

Local debug: `dsh plugin --profile web add link:<abs path>` then
`dsh web --patch <abs path>/cordis.patch.yml`.

Install from GitHub: `dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher`

See `README.zh.md` for the full guide.
