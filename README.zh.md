<h1 align="center">dsh-desktop_quick_launcher</h1>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center"><strong>dsh web 的桌面一键启动、一键重启与优雅退出 —— 且在任何情况下都不会切断正在生成的回答。</strong> 独立重建自已退役的 <code>@linxin666/dsh-desktop-launcher</code>，Apache-2.0 许可。</p>

<p align="center">
  <a href="https://github.com/KLucen/dsh-desktop_quick_launcher"><strong>GitHub</strong></a> ·
  <a href="#是什么">是什么</a> ·
  <a href="#安全重启">安全重启</a> ·
  <a href="#失败诊断">失败诊断</a> ·
  <a href="#安装">安装</a> ·
  <a href="#故障排查">故障排查</a>
</p>

## 是什么

一个双面（Host + Client）DSH Web 插件，补上本地服务缺的三件顺手事：**双击桌面图标**启动服务并打开 Web 界面、**一键重启**（宿主自己死掉也不影响）、**一键退出**——而且三者都拒绝打断正在生成的回答。

### 桌面图标（Host 半边）

`POST /api/dsh-desktop_quick_launcher/create` 会在 `<dsh-home>/desktop-quick-launcher/` 写下启动脚本并放置桌面图标（Windows `.lnk` / macOS `.command` / Linux `.desktop`；内置 dsh 图标会复制到脚本旁边，包目录移动后快捷方式依然可用）。

- **分级探针**决定该怎么做：TCP 连接 → 插件 `/ping`（是本插件，拿到 instanceId）→ `GET /` 指纹（`dsh web authentication required`）→ 外来服务。于是"DSH 已在运行 / 端口被别的程序占用 / 端口有人监听但从不响应（僵死实例）/ 端口空闲"是四种**各自有结论**的结果，而不是笼统的"未就绪"。
- **命名互斥量**串行化并发调用：连点三次图标不会再让三个启动器去抢 3080。
- 隐藏启动 `dsh web --no-open`，用 `-RedirectStandardOutput`/`-RedirectStandardError` **捕获子进程输出**，轮询到就绪（**150 秒**预算），然后用三种兜底方式打开浏览器（`Start-Process` → `explorer.exe` → `cmd /c start`）。
- 只要端口不是**空闲**，就是一条诊断而不是一次启动：启动器会报告占用者的 PID 与进程名后停止。

### 悬浮面板（Client 半边）

页面右下角：**桌面图标/详情**、**停止**、**重启**。

- **详情**弹出面板：实例信息（PID、端口、运行时长、版本）、当前生成状态、**上次启动报告**、**上次重启报告**、被抓取的子进程输出尾部。
- **停止**：确认后宿主刷完响应再优雅退出，页面自行关闭。
- **重启**：移交给独立助手，新实例就绪后页面自动回到同一会话。

### 安全重启

重启值得单独一节：装插件、升核心、重打补丁都要重启 `dsh web`，而"朴素版本"的重启是破坏性的。

- **未结束的回合会阻断重启。** 宿主读取 live session，套用 `@deepseek-ai/dsh-session` 自己的开放回合判据（最后一个 `turn/start` / `turn/end` 边界决定），返回 `409 busy` 并列出相关会话。停止与重启都受此门控；面板在生成期间禁用两个按钮，改为提供**「等空闲后自动重启」**（客户端队列，上限 10 分钟，可取消）。
- **移交过程中新开始的回合会取消重启。** 宿主在退出前会**再查一次**；若此时冒出新的回答，就写 `aborted-busy` 并且**不退出**。页面会提示"已取消：检测到新开始的回答"。
- **逃生口是刻意的。** 如果某个回合永久卡住，硬阻断会让重启按钮彻底失效，所以保留了 `force: true` —— 但只能通过**二次、措辞明确**的确认（"强制：会中断正在生成的回答"）触达，并在重启报告里记为 `forced: true`。
- **助手比宿主活得久，而且必须先证明自己活着宿主才敢退出。** 宿主把助手作为**计划任务**启动（其进程属于任务计划服务，宿主自己的清理动不到它），然后**等助手把共享状态文件推进到 `handoff` 之后**，才回 202 并退出；如果助手始终没有报到，重启会被**取消、服务继续运行** —— 重启机制坏掉不再等于服务变死。`restartMethod: detached` 可钉住降级路径（普通 detached 子进程），它明显更不可靠：在 Windows 上实测它会在**执行任何一条语句之前**就随宿主的进程树被杀掉。
  助手在宽限期后确认旧实例已消失，**恢复工作目录与 `DSH_HOME`**（计划任务的启动目录是 `%SystemRoot%\System32` 且没有 `DSH_HOME`，两者都必须显式还原），拉起新实例，并从捕获的 stdout 里解析新实例的 `dsh web: http://…/?token=…` 一行（浏览器 cookie 万一失效时有用——见"已知限制"）。助手**绝不使用 `taskkill /T`**：它是旧宿主的子孙进程，`/T` 会把它自己一起杀掉。
- **页面为什么能自己回来：** 浏览器会话 cookie 的签名密钥持久化在 `$DSH_HOME/.credentials.yaml`（默认 30 天），因此**能跨重启存活**。客户端等到 `/ping` 返回一个与重启前**不同**的 `instanceId`，然后重新加载原 URL。
- **同时只允许一次重启：** inflight 标记会让第二次请求得到 `409 restart-inflight`（双击出的两个标签页不会起两个助手）。

### 失败诊断

- 子进程的 stdout/stderr 被写入 `dsh-child.out.log` / `dsh-child.err.log`，**末尾 15 行**同时进入桌面消息框和报告。（v0.1 用 `-WindowStyle Hidden` 把输出全丢了，"代码 1"没有任何原因可查。）
- 每次运行都会**原子写** `launcher-status.json`（临时文件 + 改名，UTF-8 **无 BOM**）；重启会写 `restart-status.json`。两者都由 `GET /status` 读回。
- GUI **在页面加载时把上次启动失败提示一次**（一次性横幅）——不必再知道"有日志文件这回事"。
- 九类失败结论（`dsh-not-found`、`up-unknown`、`port-no-response`、`child-exit`、`timeout-alive`、`timeout-dead`、`mutex-held`、`up-dsh`、`error`），每类都带下一步建议。

### 安全边界

所有路由都是**仅限回环**（socket 地址 + Host 头 + `sec-fetch-site` + Origin）——这很重要，因为 DSH 的插件路由是在浏览器登录门**之外**的。此外，所有状态变更路由都要求一个由 `GET /ping` 下发的**每实例 nonce**（放在 `x-dsh-ql-nonce` 头里），否则返回 `403 nonce-required`。这能挡住跨站页面盲发 POST 到 `127.0.0.1`，但**挡不住本机进程**（它自己就能读 `/ping`）。

> 说明：`/ping` 与 `/status` 无需凭据即可读取；`/create`、`/restart`、`/shutdown` 没有 nonce 则无法生效。

### 接口

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/dsh-desktop_quick_launcher/ping` | GET | 实例 id、nonce、pid、端口、运行时长 |
| `/api/dsh-desktop_quick_launcher/status` | GET | 实例 + `busy` + 上次启动/重启报告 + 日志路径 |
| `/api/dsh-desktop_quick_launcher/create` | POST | 写启动脚本 + 桌面图标 |
| `/api/dsh-desktop_quick_launcher/restart` | POST | 移交给独立助手后退出（`409 busy` / `409 restart-inflight`） |
| `/api/dsh-desktop_quick_launcher/shutdown` | POST | 优雅退出（`409 busy`） |

### 设置项

schemastery 配置段（`desktop-quick-launcher` 命名空间）：`enabled`、`announceToAgent`、`dshCommand`、`url`、`profile`、`iconPath`、`confirmShutdown`、`restartGraceMs`（1500）、`restartTimeoutSec`（150）、`busyPolicy`（`block` | `warn`）、`restartMethod`（`auto` | `schtasks` | `detached`）、`helperStartTimeoutMs`（8000）、`showLaunchReport`。

### 真正能被加载的客户端产物

DSH 的浏览器加载器要求每个插件的 `./client` 入口是一个**经典脚本**，并通过 `window.__ModuleLoader__.load({ id, factory })` 自注册（react/react-dom 由加载器的 `require` 注入）。因此 `pnpm build` 会用 esbuild 包装步骤（`scripts/wrap-client.mjs`）产出 `lib/client.js`，并在 VM 里校验（`scripts/verify-client.mjs`）。纯 ESM 的 `client.mjs` 会让 `dsh web` 启动即失败并报 `loaded without registering ... via ModuleLoader.load` —— 见"故障排查"。

## 安装

> 尚未发布到 npm —— 请从 GitHub 安装。

**DSH Web CLI，从 GitHub 安装（推荐）：**

```bash
dsh plugin --profile web add github:KLucen/dsh-desktop_quick_launcher
# 然后重启 dsh web（装好之后也可以用面板上的重启按钮）
```

**github.com 不可达的网络（如中国大陆）改用镜像：**

```bash
dsh plugin --profile web add "https://gh-proxy.com/https://codeload.github.com/KLucen/dsh-desktop_quick_launcher/tar.gz/refs/heads/main"
```

**从仓库安装（开发用）：**

```bash
git clone git@github.com:KLucen/dsh-desktop_quick_launcher.git   # 或上面的镜像
cd dsh-desktop_quick_launcher
pnpm install
pnpm typecheck && pnpm test      # 先构建，再跑单元 + 宿主集成测试
dsh plugin --profile web add link:D:\path\to\dsh-desktop_quick_launcher
# 重启 dsh web 后生效
```

**用 `--patch` 本地调试**（仅本次启动临时挂载；包必须已经 link 进 profile 的 node_modules）。`--patch` 是**启动器级**标志，必须排在 web app 自己的标志之前：

```bash
dsh --profile web --patch D:\path\to\dsh-desktop_quick_launcher\cordis.patch.yml --no-open
```

## 手动升级

如果你是通过修改 profile `package.json` 里的版本/提交并 `pnpm install` 升级，顶层 `node_modules/dsh-desktop_quick_launcher` 条目不一定被刷新 —— 它可能仍链在旧版本的 store 目录上，直到被重建。

1. 移除陈旧条目：`dsh plugin --profile web remove dsh-desktop_quick_launcher`
   （或直接删掉 `node_modules/dsh-desktop_quick_launcher`）。
2. 重新从 GitHub 安装（见上）。
3. 确认该条目带有 `lib/client.js`（包装后的经典脚本）与 `lib/index.mjs`，然后重启 `dsh web`。

从 **0.1.x** 升级还需要**重新生成桌面图标**（面板上的图标按钮）：启动脚本格式变了，拉一份新的 `launcher.ps1` 才会启用分级探针、互斥量和子进程输出捕获。

## 故障排查

**"Failed to load plugins ... loaded without registering 'dsh-desktop_quick_launcher' via ModuleLoader.load"（dsh web 在插件页就起不来）**

已安装副本的 `./client` 入口是纯 ESM 产物、或是没有注册调用的手改文件。仓库修复（≥ 提交 `bcfaf9d`）会把客户端构建成调用 `window.__ModuleLoader__.load` 的经典脚本；用 PowerShell 手写的包装还会破坏 UTF-8（界面乱码），所以优先从源码重建：

- 拉取/重建仓库（`pnpm install && pnpm build`），按上面的方式从 GitHub 重装，并重启 `dsh web`。
- 快速自查：`node_modules/dsh-desktop_quick_launcher/lib/client.js` 必须以 `window.__ModuleLoader__.load({` 开头，且字符串里的中文正常。

**"从 GitHub 装了但 Web 界面里什么都没有"**

- 安装后必须**完整重启** `dsh web`（客户端产物在启动时加载）。
- 确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-desktop_quick_launcher`；没有就补上。
- 确认右下角按钮没有被别的浮层盖住；看浏览器控制台是否有提到该 id 的 `ModuleLoader` 报错。

**"重启/停止按钮是灰的"或"409 busy"**

这是插件在按设计工作：有会话存在未结束的回合，即正在生成回答。等它结束、用**「等空闲后自动重启」**，或者（仅当该回合确实卡死）走措辞明确的强制确认。`GET /status` 会在 `busy.openTurns` 里列出相关会话。

**"409 restart-inflight"**

已有一次重启正在进行；该标记存活 90 秒。如果上一次助手中途死掉，等标记过期，或删除 `<dsh-home>/desktop-quick-launcher/restart-inflight.json`。

**用 curl 调接口时"403 nonce-required"**

先 `GET /api/dsh-desktop_quick_launcher/ping`，把它返回的 `nonce` 放进 `x-dsh-ql-nonce` 头再请求；nonce 是每实例的，每次重启都会换。

**"桌面图标启动了 dsh web，但浏览器没打开"**

- 现在启动器会**报告原因**而不是靠猜：查看 `<dsh-home>/desktop-quick-launcher/` 下的 `launcher-status.json`（`phase`、`port.ownerName`、`child.exitCode`、`child.tail`），或直接打开面板的**详情** —— 同一份报告就在那里，且下次打开 GUI 时会主动提示一次。
- `phase: "up-unknown"` 表示端口被别人占了，占用者的 PID 与进程名就在报告里。释放它，或把 `url` 指到别的端口。
- `phase: "child-exit"` 会带上子进程 stderr 的末尾 15 行，通常这就是全部答案。
- 不要在首次启动还没完成时反复双击图标：互斥量会让多出来的调用**转为等待**而不是去起一个注定失败的实例，但它们仍会占着一个控制台直到首次启动就绪。

**"重启之后页面没回来"**

- `restart-status.json` 记录了结果（`ready` / `timeout` / `failed` / `aborted-busy`）以及新实例的带 token URL；面板的**详情**里能看到。
- 如果浏览器要求认证，打开报告里的 `authUrl` —— cookie 默认能跨重启存活，但并非永久。

## 已知限制

- 重启与退出都会终止整个 `dsh web` 进程：会话会持久化并可恢复，但当前正在生成的回答不会被保留 —— 这正是插件在回合未结束时拒绝执行它们的原因。
- busy 检查读取 live session store。如果该服务缺失或 API 变化，检查会**放行**（允许重启，并在 `busyCheck` 里记录原因）—— 若改成 fail-closed，重启会永久失效。
- `busyPolicy: warn` 可恢复 v0.1 那种"只报告不阻断"的行为。
- nonce 只挡跨站浏览器请求，挡不住本机进程。
- 所有路由按设计仅限回环；对暴露到局域网的服务器，远程浏览器无法使用。
- Windows 生成的图标固定名为 `DSH-Web.lnk`，点击"生成/刷新"会覆盖桌面上的同名快捷方式。
- Windows 重启助手是 PowerShell 脚本：在禁止执行 PowerShell 的受限机器上，只剩 L2 计划任务路径（或手动重启）。
- POSIX 启动器（macOS `.command`、Linux `.sh`/`.desktop`）由同一模板生成，但只在 Windows 上开发和验证过；重启助手仅支持 Windows（POSIX 上只能由宿主自行退出后手动启动）。
- 插件尚未发布到 npm；安装走上面的 GitHub tarball（`main` 分支）。
- SDK 依赖钉在 `@deepseek-ai/* 0.1.2-rc.1` 一线，跟随 DSH 发布节奏；`dsh.engines` 声明 `>= 0.1.2-alpha.4`。

## 开发

```bash
pnpm typecheck      # tsc --noEmit
pnpm test           # 先构建，再跑：单元测试、生成脚本的 PowerShell 解析校验、宿主集成测试
```

测试套件会把真实的宿主半边挂到 stub cordis 上下文上，直接驱动真实的路由处理器，并且注入助手的 spawn 与进程退出（`ApplyHooks`）、把 `DSH_HOME` 指向临时目录 —— 因此它不会真的拉起助手、不会退出测试进程、也不会碰到你的真实 profile 或桌面。

## 许可

Apache-2.0 —— 派生自 [@linxin666/dsh-desktop-launcher](https://www.npmjs.com/package/@linxin666/dsh-desktop-launcher)；见 `NOTICE` 与 `LICENSE`。
