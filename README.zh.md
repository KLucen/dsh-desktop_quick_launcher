<h1 align="center">dsh-desktop_quick_launcher</h1>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center"><strong>dsh web 的桌面一键启动 + 一键优雅退出。</strong> 独立重建自已退役的 <code>@linxin666/dsh-desktop-launcher</code>，Apache-2.0 许可。</p>

<p align="center">
  <a href="https://github.com/KLucen/dsh-desktop_quick_launcher"><strong>GitHub</strong></a> ·
  <a href="#是什么">是什么</a> ·
  <a href="#安装">安装</a> ·
  <a href="#故障排查">故障排查</a>
</p>

## 是什么

一个双面（Host + Client）DSH Web 插件，为 `dsh web` 补上本地优先服务最缺的两种体验：**双击桌面图标即可启动服务并打开 Web GUI**，以及**在界面内一键退出**。

**桌面图标（Host，`/api/dsh-desktop_quick_launcher/create`）：** 在 `<dsh-home>/desktop-quick-launcher/` 写入启动脚本，并在桌面创建图标——Windows `.lnk` / macOS `.command` / Linux `.desktop`（随包分发的 dsh 图标会复制到脚本旁，即使包被移动，快捷方式也能继续使用）。

- 生成的启动脚本先探测 GUI 地址：已在运行 → 直接打开浏览器并退出；否则隐藏启动 `dsh web --no-open`，轮询等待就绪（**150 秒**预算）。
- 打开浏览器带三连兜底——`Start-Process` → `explorer.exe` → `cmd /c start`，基本杜绝"启动成功但没弹浏览器"。
- 每一步都写入脚本旁的 `launcher.log`（invoked / found dsh / spawned pid / 子进程早退 / ready / 每次打开尝试 / 超时），出问题看一个文件即可定位，无需猜。

**悬浮退出按钮（Client）：** 固定在页面右下角的圆形电源按钮。点击弹出**自定义确认弹窗**（非浏览器原生 confirm）；确认后 POST `/api/dsh-desktop_quick_launcher/shutdown`，请求宿主进程优雅退出（优先 `ctx.appExit`，无则回退 `process.exit(0)`），响应先送达浏览器、随后进程退出、页面自动关闭。旁边第二个小按钮可一键生成/刷新桌面图标（toast 显示结果）。

**安全边界：** 两个接口**仅限 loopback**（校验 socket 地址 + Host 头 + 同源标记），即使 `dsh web` 暴露在局域网，也无法被远程创建图标或远程关机。配置通过 schemastery 段暴露（`desktop-quick-launcher` 命名空间）：`enabled` / `announceToAgent` / `dshCommand` / `url` / `profile` / `iconPath` / `confirmShutdown`。

**可正常加载的 Client 产物：** DSH 浏览器端 loader 要求每个插件的 `./client` 入口是 classic script，且必须通过 `window.__ModuleLoader__.load({ id, factory })` 自注册（react/react-dom 由 loader 的 `require` 注入）。因此 `pnpm build` 通过 esbuild 包装步骤（`scripts/wrap-client.mjs`）产出 `lib/client.js`，并在 VM 里校验（`scripts/verify-client.mjs`）。纯 ESM 的 `client.mjs` 会让 `dsh web` 启动中止，报 `loaded without registering ... via ModuleLoader.load`——见故障排查。

**Host 端：** cordis 插件 `dsh-desktop_quick_launcher`，注入 `webServer`/`systemPrompt`，经 `cordis.patch.yml` 注册；Host 半边以 ESM 发布（`lib/index.mjs`），浏览器半边即上面的包装版 classic 脚本。

## 安装

> 尚未发布到 npm——请从 GitHub 安装。

**DSH Web CLI，从 GitHub（推荐）：**

```bash
dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher
# 重启 dsh web
dsh web
```

**无法直连 github.com 的网络（如中国大陆），走镜像：**

```bash
dsh plugin --profile web add "https://gh-proxy.com/https://codeload.github.com/KLucen/dsh-desktop_quick_launcher/tar.gz/refs/heads/main"
```

**从仓库（开发）：**

```bash
git clone git@github.com:KLucen/dsh-desktop_quick_launcher.git   # 或上面的镜像地址
cd dsh-desktop_quick_launcher
pnpm install && pnpm build        # typecheck + tsdown + wrap-client + verify-client
dsh plugin --profile web add link:D:\path\to\dsh-desktop_quick_launcher
# 重启 dsh web（或 DSH Desktop）后生效
```

**`--patch` 本地调试**（仅本次启动临时装载；包须已链接进 profile 的 node_modules）：

```bash
dsh web --patch D:\path\to\dsh-desktop_quick_launcher\cordis.patch.yml
```

## 手动升级

在 profile `package.json` 中提高版本/commit 并执行 `pnpm install` 后，顶层
`node_modules/dsh-desktop_quick_launcher` 不一定总是被刷新——它可能仍链接到旧版本的
store 目录，直到被重建：

1. 移除旧条目：`dsh plugin --profile web remove dsh-desktop_quick_launcher`（或直接删除
   `node_modules/dsh-desktop_quick_launcher`）。
2. 重新从 GitHub 添加（见上「安装」）。
3. 确认产物包含 `lib/client.js`（包装版 classic 脚本）与 `lib/index.mjs`，然后重启
   `dsh web`。

## 故障排查

**"Failed to load plugins ... loaded without registering 'dsh-desktop_quick_launcher' via ModuleLoader.load"（dsh web 在插件页中止）**

安装副本的 `./client` 入口是纯 ESM bundle，或缺少注册调用的手工补丁文件。仓库修复
（≥ commit `bcfaf9d`）会把 client 构建成调用 `window.__ModuleLoader__.load` 的 classic
脚本；经 PowerShell 手写的包装还会破坏 UTF-8（界面中文乱码），因此请从源码重建：

- 拉取/重建仓库（`pnpm install && pnpm build`），按上文从 GitHub 重装并重启 `dsh web`。
- 快速自查：`node_modules/dsh-desktop_quick_launcher/lib/client.js` 应以
  `window.__ModuleLoader__.load({` 开头，且字符串中的中文干净无乱码。

**"从 GitHub 安装了，但 Web UI 里没有任何东西"**

- 安装后务必完整重启 `dsh web`（客户端产物在启动时装载）。
- 确认 profile `package.json` 的 `dsh.profile.bundles` 里含 `dsh-desktop_quick_launcher`；
  没有就手动补上。
- 确认右下角按钮没有被其它浮层遮挡；浏览器控制台若有提及该 id 的 `ModuleLoader` 报错，请一并反馈。

**"桌面图标能启动 dsh web，但浏览器没有自动打开"**

- 打开生成脚本旁的 `launcher.log`：它记录了服务是否就绪、哪一次打开尝试（若有）失败。
- 首次启动尚未完成时不要反复双击图标——多个 launcher 实例会各自拉起一个 `dsh web`，
  第二个实例会因 3080 端口被占用而退出（脚本会提示「DSH 进程启动后退出」）。请等待首次启动
  （最长 150 秒），或先停止旧实例再启动。

## 已知限制

- 退出按钮会终止整个 `dsh web` 进程：当前宿主中的会话/任务会被中断（会话有持久化，
  重启后可恢复）。
- `/create` 与 `/shutdown` 刻意仅限 loopback；通过远程浏览器连接局域网暴露的服务时不可用。
- 生成的 Windows 图标名为 `DSH-Web.lnk`，点击「生成/刷新」会覆盖桌面上同名快捷方式。
- POSIX 启动脚本（macOS `.command`、Linux `.sh`/`.desktop`）由同一模板生成，但在 Windows
  上开发与验证；如有问题请附 `launcher.log`/终端输出反馈。
- 插件尚未发布到 npm，安装使用上面的 GitHub tarball（`main` 分支）。
- SDK 依赖锁定在 `@deepseek-ai/* 0.1.2-rc.1` 一线，随 DSH 发布节奏更新；`dsh.engines`
  声明 `>= 0.1.2-alpha.4`。

## 许可

Apache-2.0——迁移自 [@linxin666/dsh-desktop-launcher](https://www.npmjs.com/package/@linxin666/dsh-desktop-launcher)；详见 `NOTICE` 与 `LICENSE`。
