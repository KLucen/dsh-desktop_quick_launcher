# dsh-desktop_quick_launcher

DSH Web 插件：**桌面一键启动 + 右下角一键退出**（独立重建自已退役的 `@linxin666/dsh-desktop-launcher`，Apache-2.0）。

仓库：https://github.com/KLucen/dsh-desktop_quick_launcher

## 功能

- **右下角圆形电源按钮（⏻）**：点击弹出**自定义确认弹窗**（非浏览器原生 confirm），确认后请求宿主进程优雅退出（`ctx.appExit`，无则回退 `process.exit(0)`），页面随后自动断开。
- 电源按钮旁的**蓝色小按钮**：生成/刷新桌面启动图标（toast 显示结果）。
- 生成的桌面图标（Windows `.lnk` / macOS `.command` / Linux `.desktop`）双击后：探测 3080 → 已运行则直接开浏览器；未运行则隐藏启动 `dsh web --no-open`，就绪轮询 **150 秒**，随后自动打开浏览器。
- 启动脚本**全程写日志**（`<脚本目录>/launcher.log`）：invoked / found dsh / spawned pid / 子进程早退 / ready / 每次开浏览器尝试 / 超时，均可追溯。
- 开浏览器三连兜底：`Start-Process url` → `explorer.exe url` → `cmd /c start url`。
- Host 接口 `/api/dsh-desktop_quick_launcher/create`、`/shutdown` **仅限 loopback**（防 LAN 暴露被外部触发）。

## 构建与本地调试

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm build         # tsdown -> lib/index.mjs + lib/client.mjs (+ d.ts)

# 本地调试：先链接进 web profile，再带 patch 启动
dsh plugin --profile web add link:D:\DSHWorkplace\desktop_quick_launcher
dsh web --patch D:\DSHWorkplace\desktop_quick_launcher\cordis.patch.yml
```

> `--patch` 只对本次启动临时装载；patch 行引用的包名必须在 profile 的
> node_modules 可解析（所以先执行 add link）。

## 从 GitHub 安装

```bash
dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher
```

**安装后验证**：重启 `dsh web` →
1. 页面右下角出现红色圆形电源按钮与蓝色图标按钮；
2. 点电源按钮 → 弹出自定义确认框 → 确认后服务退出、页面断开；
3. Host 探针（可选）：

   ```powershell
   Invoke-RestMethod http://127.0.0.1:3080/api/dsh-desktop_quick_launcher/create -Method Post
   # { result = { ok = True; path = "...\Desktop\DSH-Web.lnk"; platform = "win32" } }
   ```
4. 配置段见「设置 → 插件配置」（enabled / announceToAgent / dshCommand / url /
   profile / iconPath / confirmShutdown）。

## 代码结构（迁移说明）

| 文件 | 内容 |
|---|---|
| `src/index.ts` | Host 端：`/create` + `/shutdown` 路由（loopback）、settings 配置段、可选 systemPrompt 段、图标生成实现 |
| `src/core/launcher.ts` | 纯模板生成器：PowerShell / POSIX 启动脚本、Windows `.lnk` 安装器、Linux `.desktop`（自上游迁移并加固） |
| `src/client.ts` | Client 端：右下角电源按钮 + 自定义确认弹窗 + 生成图标按钮/toast（零 client-SDK，纯 fetch + react-dom） |
| `cordis.patch.yml` | `dsh.bundle.patch` 装载行 |
| `assets/` | dsh 图标（随包复制到脚本目录） |

`package.json` 关键字段：`name: dsh-desktop_quick_launcher`、
`dsh.bundle.patch`、`dsh.client.platform: web`、`exports["./client"]`。
Host/Client 仅依赖官方 SDK（`@deepseek-ai/cordis`、`dsh-host-webserver`、
`dsh-settings`、`dsh-system-prompt`），不改 dsh 源码。

## 许可

Apache-2.0（迁移自 @linxin666/dsh-desktop-launcher，见 NOTICE / LICENSE）。
