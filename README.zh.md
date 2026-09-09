# desktop-quick-launcher

DSH Web 插件的桌面一键启动器（独立重建自已退役的 `@linxin666/dsh-desktop-launcher`，Apache-2.0）。

- 在 DSH 设置页开启后，右下角出现**悬浮控制面板**：
  - **生成桌面图标**：在 `$DSH_HOME/desktop-quick-launcher/` 写入启动脚本，并在桌面创建一键启动图标（Windows `.lnk` / macOS `.command` / Linux `.desktop`），双击即启动 `dsh web` 并自动打开浏览器（120 秒就绪轮询 + 双通道开浏览器 + `launcher.log` 日志，避免原版 WPF 弹窗版偶发不开浏览器的缺陷）。
  - **停止服务**：请求宿主进程优雅退出（`ctx.appExit`，无则回退 `process.exit(0)`）。
- Host 端两个接口均只接受本机回环（loopback）请求，防止 LAN 暴露时被外部触发。

## 快速开始（构建）

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown -> lib/index.js + lib/client.js
```

## 本地调试（--patch）

```bash
# 1) 构建
pnpm build
# 2) 把本插件链接进 web profile（等价于 dsh plugin add）
dsh plugin --profile web add link:D:\DSHWorkplace\desktop_quick_launcher
# 3) 带 patch 启动（dsh web = --profile web）
dsh web --patch D:\DSHWorkplace\desktop_quick_launcher\cordis.patch.yml
#    等价写法（在 profile 目录下）：pnpm dsh web --patch ./cordis.patch.yml
# 4) 打开 http://127.0.0.1:3080，观察右下角悬浮面板
```

> 说明：`--patch` 只是本次启动临时装载，patch 引用的包名必须能在 profile 的
> node_modules 里解析，所以先执行第 2 步。去掉 `--patch` 后插件不再装载。

## 从 GitHub 安装

```bash
dsh plugin --profile web add github:<你的用户名>/desktop-quick-launcher
```

然后**重启 dsh web**，验证：

1. 网页右下角出现「DSH 快速启动」悬浮面板；
2. 点「生成桌面图标」→ 返回桌面路径/警告；
3. Host 探针（可选）：

   ```powershell
   Invoke-RestMethod http://127.0.0.1:3080/api/desktop-quick-launcher/create -Method Post
   # { result = { ok = True; path = "...Desktop\DSH-Web.lnk"; platform = "win32" } }
   ```
4. 配置项见「设置 → 插件配置 → desktop-quick-launcher」（enabled / announceToAgent /
   dshCommand / url / profile / iconPath / confirmShutdown）。

## 目录结构与迁移说明

| 文件 | 说明 |
|---|---|
| `src/index.ts` | Host 端（webServer 路由 + settings 段 + systemPrompt 段 + 图标生成实现） |
| `src/core/launcher.ts` | 纯模板生成器（迁移自上游 `core/launcher.ts`，PS/POSIX 启动脚本 + 安装器） |
| `src/client.ts` | Client 端悬浮面板（零 client-SDK 依赖，纯 fetch + react-dom） |
| `cordis.patch.yml` | `dsh.bundle.patch` 装载行（id + 包名） |
| `assets/` | dsh 图标（随包分发，复制到脚本目录保证快捷方式长期可用） |

`package.json` 关键字段：`dsh.bundle.patch`、`dsh.client.platform: "web"`、
`exports["./client"]`（浏览器半边入口）。Host/Client 共用官方 SDK 类型
（`@deepseek-ai/cordis` / `dsh-host-webserver` / `dsh-settings` /
`dsh-system-prompt`），不修改 dsh 源码。

## 与已退役原版 / web-all 全家桶的关系

- 移除：全家桶的 `RETIRED_PLUGINS` 行、`web-ui.plugin.item` 槽位、alpha.4 时代
  client SDK（ui-slots / ui-renderer / ui-settings）依赖、遥测心跳、共享目录
  `~/.dsh/desktop-launcher/`（本插件改用独立目录 `desktop-quick-launcher/`）。
- 保留并迁移：生成器（launcher/installer 模板）、loopback 安全围栏、
  `/create` 与 `/shutdown` 路由语义、`ctx.appExit` 优雅退出、settings 命名空间。

## 许可

Apache-2.0（源码迁移自 [@linxin666/dsh-desktop-launcher](https://www.npmjs.com/package/@linxin666/dsh-desktop-launcher)，见 NOTICE 与 LICENSE）。
