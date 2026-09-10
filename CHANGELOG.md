# Changelog / 更新日志

**工程规矩（本仓库长期约定）**：每次 push 到 `main` 都必须在**本文件**与 **README 的「更新日志」小节**写清两件事 —— **本次修复了哪些 bug**、**新增了哪些功能**。只写提交信息不算完成。

Every push to `main` documents its fixes and features here and in the README changelog section.

---

## v0.2.7 — 2026-09-10

### 修复 / Fixed
- **"桌面快捷方式不存在"误报**：客户端 bundle 是从磁盘实时提供的，所以装完新版本但**宿主进程还没重启**时，会出现"界面是新版、宿主是旧版"的错位；旧宿主的 `/status` 没有 `shortcut` 字段，新版界面把"字段缺失"当成了"快捷方式被删除"。现在：面板与卡片都会**显式报告版本错位**（`client vX / host vY` + "请重启服务"），并把缺失字段显示为"**无法确认**"而不是"不存在"。

### 说明 / Notes
- 这一版也修正了我自己的发布流程漏洞：此前只核对了"**已安装的文件**是哪个版本"，没有核对"**正在运行的宿主**是哪个版本"。以后每次发布都必须用 `GET /ping` 确认 `pluginVersion` 已变为新版本。

### 验证 / Verified
- `pnpm typecheck` 通过；`pnpm test` **49/49**。
- 用真实实例复现了错位现场（宿主 0.2.5 / 客户端 0.2.6，`/status` 无 `shortcut` 字段 → 界面误报"不存在"），修复后同样的错位会显示版本提示与"无法确认"。

---

## v0.2.6 — 2026-09-10

### 新增 / Added
- **一键重建桌面快捷方式**：详情面板（右下角启动器按钮点开）顶部与设置卡片各有一个「重新生成桌面快捷方式」按钮；快捷方式缺失时按钮变主色高亮，并显示黄色警示。
- `GET /status` 新增 `shortcut { name, path, exists }`，面板因此能**主动发现**快捷方式被删除，而不是等你发现。

### 修复 / Fixed
- **删除桌面快捷方式后无法从界面恢复**：0.2.2 把图标按钮改成"打开详情"后，`onCreate` 再没有被调用过（死代码），UI 上没有任何生成入口。现已补回，并放在用户期望的位置。
- `package.json` 的版本号与代码内 `PLUGIN_VERSION` 不一致（装出来显示 0.2.5、运行时自称 0.2.6），已同步为 0.2.6。

### 有意不做 / Deliberately not done
- 开机时**不**自动重建快捷方式：否则"我故意删掉图标"每次重启都会长回来。语义是"删了就是删了，但界面会提示你，一键可恢复"。

### 验证 / Verified
- 在真实实例上复现了用户场景：`DSH-Web.lnk` 确实不存在 → `POST /create` 返回 200 → 重建出的 `.lnk` 指向 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <scripts>\launcher.ps1`。
- `pnpm typecheck` 通过；`pnpm test` **49/49**（新增 `/status.shortcut` 形状断言）。

---

## v0.2.5 — 2026-09-10

### 修复 / Fixed
- **启动器脚本永远不更新（本版最重要的修复）**：桌面快捷方式指向固定路径，而此前只有"点图标按钮重新生成"才会重写脚本 —— 实测磁盘上的 `launcher.ps1` 是**两个版本之前**的，于是 0.2.3/0.2.4 对启动器的所有修复**从未生效**（表现为：打开裸 origin → 404 → 刷新 401）。现在**宿主每次启动都会重写已存在的 `launcher.ps1`**（幂等、不会自己创建图标），任何升级都会自动作用到现有快捷方式。
- 设置卡片移除「刷新 / 打开目录 / 全部清空」三个按钮（用户要求）。逐文件的「查看 / 清空」保留。

### 验证 / Verified
- 探针分支用**生成的 PowerShell** 实测：真实 3080 → `up-dsh`；伪造的"ping 200 但 `/` 返回 404"（正是启动窗口）→ `starting`（等待而非打开浏览器）；"ping 200 + 认证正文" → `up-dsh`；无人监听 → `down`。
- 真实 3080 上的 token 流程：无 cookie 裸 origin → **401**；token URL → **303 + Set-Cookie**；跟随 → **200 且含 `__DSH_BOOT__`**；手动刷新（token URL 与带 cookie 的裸 `/`）→ 303 / **200**。
- `pnpm test` **48/48**（新增"启动时重写已有 launcher.ps1 且幂等"）。

---

## v0.2.4 — 2026-09-10

### 修复 / Fixed
- **就绪判定太弱导致 404**：`/ping` 返回 200 只证明插件路由活着；SPA 兜底处理器注册之前，服务器对一切未认领路径返回 **404**，因此浏览器被过早打开（`HTTP ERROR 404`，刷新后才正常）。新增 `Test-GuiReady`：必须**带 token 的 URL 返回 2xx/3xx**，或 `/` 返回 DSH 认证正文/2xx，才算就绪。
- 新增 `starting` 阶段（"服务起了、界面还没好"）：启动器**只等待、绝不重复起第二个实例**；重启助手同样要等界面真的应答才算完成。

### 变更 / Changed
- 移除常驻的"有回答正在生成 / 等空闲后自动重启"提示块（用户要求）；生成期间仍禁用两个按钮，悬停提示说明原因。
- 悬浮件在 DSH 自己的模态框（`aria-modal`/`dialog[open]`）打开时**整体隐藏**：它们挂在 `#root` 之外的 `body` 上且 z-index 极高，会压在设置弹窗之上并可能吞掉点击。

### 验证 / Verified
- `pnpm test` **47/47**（新增就绪门与 `starting` 分支的断言）。

---

## v0.2.3 — 2026-09-10

### 修复 / Fixed
- **桌面启动器打开裸 origin 导致 `dsh web authentication required`**：新增 `Resolve-OpenUrl` 三级回退 —— `/ping` 的 `authUrl`（宿主用 `connection.authenticatedUrl` 取，与 dsh-web-app 同一 API，并缓存到 `auth-url.txt`）→ 自己启动的子进程 stdout 里的 `dsh web: …?token=…` → `auth-url.txt` → 最后才是裸 `$url`。`Open-Browser` 改为接收目标 URL。
- 设置卡片：所有按钮补 `type="button"`（设置面板若包在 `<form>` 里，未声明类型的按钮默认是 submit，点击会被吞掉）；开关的读写从 `ctx.settingsScope` 解耦为 `GET /status.config` + `POST /options`；所有失败都在卡片里以红字显示，不再静默；卡片新增"最近操作"诊断行。

### 验证 / Verified
- `pnpm test` **46/46**（`/options` 的 nonce/allowlist/类型校验/回显，启动器 URL 解析断言）。

---

## v0.2.2 — 2026-09-10

### 新增 / Added
- **设置卡片**（`settings.section` 槽位）：三个悬浮按钮（详情/停止/重启）各自独立开关；面板显示本插件生成的全部日志与状态文件（大小、修改时间），可逐文件查看末尾内容与清空。
- 新增回环路由 `GET /logs`、`POST /logs/clear`、`POST /logs/open`；日志名走**服务端白名单**，绝不接受调用方路径（`../../etc/passwd` 之类一律 404），写操作需 nonce。

### 验证 / Verified
- `pnpm test` **44/44**；测试 harness 升级为真实调用 `installSection` 并触发 `setSource`/`onChange`。

---

## v0.2.1 — 2026-09-10

### 修复 / Fixed
- **重启助手被宿主退出连带杀死**：L1 detached 子进程会被进程树清理连坐（实测"一行都没执行"），改为**计划任务为主**（父级是 Task Scheduler 服务，天然在树外）；detached 降级为 `restartMethod: detached` 可选。
- **计划任务环境的 cwd 与 DSH_HOME 都是错的**（`%SystemRoot%\System32`、无 `DSH_HOME`）：助手现在显式 `Set-Location` + `$env:DSH_HOME`，并给 `Start-Process` 传 `-WorkingDirectory`。
- **新增启动验证门**：`POST /restart` 必须等助手把 `restart-status.json` 推进到 `handoff` 之后才回 202 并退出；否则写 `phase: failed`、清 inflight、回 **500 `helper-not-started`，宿主保持运行** —— 重启机制坏掉不再等于服务变死。

### 验证 / Verified
- `schtasks /create` + `/run` 经 `execFile` 实测；`pnpm test` **40/40**（含"助手从未启动 ⇒ 500 且不退出"）。

---

## v0.2.0 — 2026-09-10

### 新增 / Added
- **分级端口探针**：TCP 连接 → 插件 `/ping`（拿到 instanceId）→ `GET /` 的 DSH 认证指纹 → 外来服务，区分「DSH 已就绪 / 端口被非 DSH 占用 / 端口被占但无响应 / 端口空闲」。
- **捕获子进程 stdout/stderr**：早退时给出末尾 15 行，同时进入桌面消息框与状态文件（v0.1 用 `-WindowStyle Hidden` 把输出全丢了）。
- **机器可读状态文件**：`launcher-status.json` / `restart-status.json`（原子写、UTF-8 无 BOM），九类失败结论各有建议。
- **单实例守卫**：命名互斥量（消除并发启动抢端口）+ spawn 前的端口占用者分类 + restart inflight 标记。
- **一键重启**：宿主移交后优雅退出，助手拉起新实例，页面自动回到原会话。
- **nonce**：三个状态变更路由校验 `x-dsh-ql-nonce`（`/ping` 下发）——注意这些路由**不在浏览器登录门之内**，只受回环围栏保护。
- **不切断正在生成的回答**：宿主读取 live session、套用 `dsh-session` 自己的开放回合判据（最后一个 `turn/start|turn/end` 边界），生成期间 `409 busy`；退出前**二次检查**，期间冒出回合则写 `aborted-busy` 并**不退出**；前端禁用按钮 + 等空闲队列；`force` 仅经二次明确确认，并记 `forced: true`。

### 验证 / Verified
- `pnpm test` **37/37**（纯函数单测 + 用真实 PowerShell 解析器校验生成脚本 + 宿主路由集成测试）。

---

## v0.1.1 — 2026-09-09

### 新增 / Added
- 右下角圆形电源按钮 + 自定义确认弹窗；生成/刷新桌面图标按钮。
- 启动器全流程日志（`launcher.log`）、三种兜底打开浏览器、150 秒就绪预算。

### 修复 / Fixed
- 包名与仓库对齐为 `dsh-desktop_quick_launcher`。

---

## v0.1.0 — 2026-09-09

### 新增 / Added
- 从已退役的 `@linxin666/dsh-desktop-launcher` 独立重建（Apache-2.0）：桌面图标启动 dsh web 并打开 Web 界面；宿主优雅退出。
- **客户端产物必须以 `window.__ModuleLoader__.load({ id, factory })` 自注册**（纯 ESM 的 `client.mjs` 会让 `dsh web` 启动即失败）。
