# dsh-desktop_quick_launcher v0.2 实现方案：① 重启闭环 + 单实例守卫，② 失败诊断

状态：**已按用户决策定稿，待实现**（本文件不含实现代码）。目标版本 `0.1.1 → 0.2.0`。

已确认的决策：
- **D-A** 幸存者机制**只做 L1 + L2**（detached spawn 为主、schtasks 兜底），不做 L3（wmic + 纯 batch）。
- **D-B** **纳入 nonce**（防浏览器跨站触发状态变更路由）。
- **D-C** **不接受切断正在生成的回答**：宿主侧硬阻断（`409 busy`），前端在生成中禁用重启并提供「等空闲后自动重启」队列。

适用范围：`src/` 三个文件 + 新增 `src/core/busy.ts`、`src/core/status.ts` + `test/`；不改 cordis 描述清单，不加运行时依赖。

---

## 1. 目标与验收标准（Definition of Done）

### ① 重启闭环 + 单实例守卫

- D1.1 GUI 右下角悬浮面板可一键「重启服务」；新实例就绪后**浏览器自动回到原会话**，不需要用户去控制台复制带 token 的 URL。
- D1.2 重启助手不被宿主的进程树清理连带杀死。
- D1.3 任一时刻只有一个启动/重启流程在飞；消除 `launcher.log` 记录的 2026-09-10 事故（3 次并发调用 → 抢 3080 → `timeout: service did not become ready within 120s`）。
- D1.4 `/status` 随时可见：实例身份（instanceId/pid/port/uptime）、重启阶段、上次启动与上次重启的结论。
- **D1.5 只要有回合未结束（有回答正在生成），重启与退出都必须被拒绝**：`409 busy`，且前端在生成期间禁用两个入口；支持「等空闲后自动重启」。**任何情况下都不得静默切断生成中的回答。**
- D1.6 `create` / `restart` / `shutdown` 三个状态变更路由必须校验一次性 nonce。

### ② 失败诊断

- D2.1 桌面图标启动失败时，结论**出现在 GUI 里**，不是只躺在 `launcher.log` 里。
- D2.2 launcher 消息框带**分类结论 + 下一步建议**（当前只有一句"进程启动后退出（代码：1）"）。
- D2.3 子进程 stdout/stderr 被捕获；早退/超时时给出尾部 15 行（当前 `-WindowStyle Hidden` 把输出全丢了，这是最大的诊断黑洞）。
- D2.4 探针能区分：DSH 已就绪 / 端口被非 DSH 占用 / DSH 在监听但无响应（僵死）/ 端口无人监听。

### 非目标（明确不做）

托盘常驻、开机自启、给 Agent 暴露重启工具、多实例/多 profile 快捷方式工厂、POSIX 实机验证、`/create` 语义变更、wmic 级降级助手。

---

## 2. 已核实的事实（本机实测，设计直接依赖）

| # | 事实 | 证据 |
|---|---|---|
| F1 | DSH web 认证 = 进程级 launch token（`?token=`，每进程新随机）换**签名 cookie**；签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录，`cookieMaxAgeDays` 默认 **30 天** | `dsh-client-connection/lib/index.js:240-246,321-337,370-377,742`；本机 `.credentials.yaml` 存在且含该 record |
| F2 | **推论**：重启后旧标签页 cookie 仍有效 ⇒ 自动回到界面可行；只有换 `$DSH_HOME` 或 cookie 过期才需要新 token URL | 同 F1 |
| F3 | `dsh web` 用 `console.log('dsh web: ' + authenticatedUrl)` 打印带 token 的 URL，只受 `config.printUrl` 控制（**无 TTY 判断**）⇒ 重定向 stdout 即可捕获新 token | `dsh-web-app/lib/index.js:198-206` |
| F4 | 未认证 `GET /` → 401，正文固定 `dsh web authentication required; reopen the URL printed by dsh web.`（可作**无凭据指纹**）；未注册路径 → 裸 404 | curl 实测 |
| F5 | **插件注册的路由不受浏览器认证门保护**：`POST /create`、`/shutdown` 不带 cookie 也返回 **200**（只受 loopback 围栏约束）；未注册的 `/api/*` 返回 401 `unauthorized` | curl 实测 |
| F6 | **推论**：launcher（无 cookie）可用插件 `/ping` 做二级指纹；同时 `/shutdown` 仅靠 `sec-fetch-site`/`Origin` 挡跨站 ⇒ 需要 nonce（D-B） | 同 F5 |
| F7 | `WebRoute = { kind:'exact'\|'prefix', path, handler(req,res) }`；`ctx.webServer.port` / `.host` 给真实监听端口与绑定主机 | `dsh-host-webserver/lib/types/index.d.ts:30-39,80-91` |
| **F8** | **"回合未结束"是官方语义、可精确判定**：session 日志以 `turn/start` … `turn/end` 成对；最后一个边界若是 `turn/start` 即"开放回合"。`dsh-session` 自己的 fork 守卫就是这么判的（抛 `OPEN_TURN`） | `dsh-session/lib/types/index.js:1058-1060`；`invariant.js:33-51`（`openTurn`）；`known-event-types.js:75` |
| **F9** | **宿主可枚举 live session 并读取事件**：`ctx.sessions: SessionStore`（`declare module` 注入键 `sessions`），`list(): Session[]`；`session.snapshotEvents(fromSeq?, toSeqExclusive?)` 返回冻结快照（未追加时复用缓存快照） | `dsh-session/lib/types/index.d.ts:24-27,187,317,424` |
| F10 | `--patch` 是**启动器级**标志：`dsh --profile web --patch <p> [--port N --no-open]`；`dsh web --patch …` 不是受支持形态 | `dsh --help` |
| F11 | 当前实例：3080、`node`、pid 22084；`dshHome` = `C:\Users\KLEE\.dsh` | 本轮实测 |

> F5 最反直觉：**不要假设 `/api/dsh-desktop_quick_launcher/*` 需要登录**——它不需要。F8 是本轮最重要的发现：D-C 不需要靠 DOM/启发式猜"是否在生成"，宿主有精确信号。

---

## 3. 路由与契约

### 3.1 路由表

| 路由 | 方法 | loopback 围栏 | nonce | 说明 |
|---|---|---|---|---|
| `/api/dsh-desktop_quick_launcher/ping` | GET | ✅ | — | 实例身份 + **nonce 下发**；launcher 二级指纹；前端重启后轮询 |
| `/api/dsh-desktop_quick_launcher/status` | GET | ✅ | — | 实例 + **busy（开放回合）** + 上次启动报告 + 重启进度 + 端口占用者 + 日志路径 |
| `/api/dsh-desktop_quick_launcher/create` | POST | ✅ | ✅ | 现有，行为不变；结果额外落盘 |
| `/api/dsh-desktop_quick_launcher/restart` | POST | ✅ | ✅ | **新增**；busy 时 409 |
| `/api/dsh-desktop_quick_launcher/shutdown` | POST | ✅ | ✅ | 现有行为 + nonce |

`ping` / `status` 无副作用，可被 launcher 与前端反复轮询。

### 3.2 `GET /ping` → 200

```json
{
  "ok": true,
  "plugin": "dsh-desktop_quick_launcher",
  "pluginVersion": "0.2.0",
  "instanceId": "4f1c9d2e-6a77-4a1f-9c33-0b7e5d1a8f20",
  "nonce": "b2f1a8c4-0d55-4e2b-9a77-1c3d5e7f9a01",
  "pid": 22084,
  "port": 3080,
  "host": "127.0.0.1",
  "startedAt": "2026-09-10T09:10:29.000Z",
  "uptimeMs": 120345
}
```

`instanceId` 与 `nonce` 均 `randomUUID()`、`apply()` 时各生成一次。**nonce 故意放在 ping 里**：跨站页面读不到它（响应无 CORS 头），而 launcher 与本页同源客户端能读到。

### 3.3 `GET /status` → 200

```json
{
  "ok": true,
  "instance": { "...同 ping（含 nonce）..." },
  "busy": {
    "known": true,
    "check": "sessions",
    "generating": true,
    "openTurns": [
      {
        "sessionId": "session-42",
        "title": "修复 launcher 自动开页",
        "turn": 7,
        "startedAt": "2026-09-10T09:28:11.000Z",
        "quietMs": 1400
      }
    ],
    "checkedAt": "2026-09-10T09:31:02.000Z"
  },
  "config": { "dshCommand": "dsh", "url": "http://127.0.0.1:3080", "profile": "", "confirmShutdown": true },
  "port": { "listening": true, "ownerPid": 22084, "ownerName": "node", "isSelf": true },
  "launcher": { "statusPath": "…\\launcher-status.json", "ageMs": 5400, "report": { "...§5.4..." }, "readError": null },
  "restart": {
    "statusPath": "…\\restart-status.json", "ageMs": 310,
    "inflight": { "instanceId": "4f1c…", "helperPid": 31872, "at": "…", "ttlMs": 90000 },
    "report": { "...§5.4..." }, "readError": null
  },
  "logs": { "dir": "…", "launcherLog": "…", "restartLog": "…", "childOut": "…", "childErr": "…" }
}
```

`busy.known:false` 时 `openTurns` 为 `[]` 且 `check:"unavailable: <原因>"`（见 §4.3 策略）。

### 3.4 `POST /restart`

请求头：`x-dsh-ql-nonce: <nonce>`（必需）。
请求体（均可省略）：`{ "reason": "ui", "graceMs": 1500, "force": false }`

响应：

- `202` `{ ok:true, accepted:true, instanceId, statusPath, helper:{path,method:'detached'|'schtasks',pid}, etaMs:30000 }`
- **`409` `{ ok:false, code:'busy', busy:{...§3.3...} }`** ← D1.5 的硬阻断
- `409` `{ ok:false, code:'restart-inflight', inflight:{...} }`（TTL 内重复请求；`force:true` 可绕过）
- `403` `{ ok:false, code:'nonce-required' }` / `403 { code:'forbidden' }` / `405`
- `202` 之后仍可能被**二次检查取消**（§4.1），取消结果写在 `restart.report.phase === 'aborted-busy'`

### 3.5 状态文件（磁盘契约）

两份 JSON 都在 `<dshHome>/desktop-quick-launcher/`，`schema: 1`，**临时文件 + `Move-Item -Force` 原子替换**。字段见 §5.4。

---

## 4. ① 设计

### 4.1 成功路径时序（优雅退出优先 + 双相 busy 检查）

关键选择：**不靠助手杀宿主**。宿主自己优雅退出（`ctx.appExit`），助手只做"监督 + 兜底 + 拉起新实例"。

```
T+0ms      UI       点「重启服务」→ 确认弹窗 → POST /restart（带 nonce）
T+5ms      host     围栏 → nonce → inflight marker
T+8ms      host     【busy 检查 #1】openTurns 非空 ⇒ 409 busy（结束，不 spawn）
T+12ms     host     写 restart-status.json { phase:'handoff', instanceIdBefore, hostPid }
T+16ms     host     spawn 助手（L1 detached；失败降 L2 schtasks）
T+25ms     host     202 { accepted, instanceIdBefore, helper, etaMs }（先刷响应）
T+30ms     host     写 inflight marker
T+1000ms   host     【busy 检查 #2】退出前复检
                     ├─ 仍空闲 → setTimeout(requestExit(0), graceMs)
                     └─ 出现新回合 → 写 phase='aborted-busy' + 删 inflight marker + **不退出**
T+1500ms   host     requestExit(0) 优雅退出（复用现有 requestExit）
T+3500ms   helper   phase='verifying-old'：读 status 文件
                     ├─ phase==='aborted-busy' → 自退，不杀不拉
                     └─ 否则查端口：已释放 → 跳过杀；仍监听 → phase='killing' 兜底杀（§4.2 规则）
T+4500ms   helper   phase='spawning'：Start-Process <dshCommand> web --no-open
                     stdout/stderr → dsh-child.{out,err}.log
T+5000ms   helper   从 child out 解析 /^dsh web: (\S+)/ → authUrl（F3）
T+5000ms+  helper   每 500ms GET /ping，直到 200 且 instanceId ≠ instanceIdBefore
T+12~30s   helper   phase='ready' + ready{instanceId,pid,waitedMs} + authUrl
T+25ms+    client   每 1s GET /ping（服务下线期间 fetch 失败属正常，不终止）
                     → 不同 instanceId → GET /status → 展示报告 → location.replace(savedHref)
```

助手超时：`readyDeadline = 150s`，硬上限 180s → 写 `phase='timeout'` 后退出。前端 `waiting` 90s → `timeout`（保留弹窗）。

**残余竞态（如实声明）**：检查 #2 与 `requestExit` 之间仍有约 50ms 级窗口（`requestExit` 本身是同步的），极小概率切到一个刚开始的回合。不追求零窗口——代价是引入会话锁，复杂度不成比例。

### 4.2 幸存者机制：L1 + L2（按 D-A）

**问题**：`taskkill /T` 按 `ParentProcessId` 递归，会连带杀死任何"还是宿主子孙"的助手。

**铁律（助手脚本必须满足，测试要断言）**：

1. **绝不使用 `taskkill /T`。** 兜底清理只 `taskkill /PID <pid> /F`，逐个、不带 `/T`；跳过自身 `$PID`。
2. 助手不 spawn 自己的副本。

| 级别 | 机制 | 父进程 | 失败特征 / 判定 |
|---|---|---|---|
| L1（主） | `spawn(file, args, { detached:true, windowsHide:true, stdio:'ignore' })` + `child.unref()` | 宿主 | `restart-status.json` 停在 `verifying-old`/`killing` 且 `restart-helper.log` 无后续行 |
| L2（兜底） | `schtasks /create /f /tn DSH-Web-Restart /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <helper.ps1>" /sc once /st 00:00` 然后 `schtasks /run /tn DSH-Web-Restart`，完成后 `/delete /f` | 任务计划服务 | 本机 `dsh-upgrade-runbook.md` 已实测可用 |

L1 失败时**自动降级**到 L2 并重试一次；实际使用级别写入 `helperMethod`，`/status` 回显。L3（wmic）已按 D-A 移除。

### 4.3 busy 阻断（D1.5，基于 F8/F9）

```ts
// src/core/busy.ts —— 纯函数，可单测
export interface TurnBoundary { type: string; time: string; turn?: number }
export interface SessionView { id: string; title?: string; events: readonly TurnBoundary[] }
export interface OpenTurn { sessionId: string; title?: string; turn: number; startedAt: string; quietMs: number }
export function findOpenTurns(sessions: readonly SessionView[], now: number): OpenTurn[]
```

判定算法（与 `dsh-session` 的官方 guard 同构）：对每个 live session，取 `snapshotEvents()`，`findLast(e => e.type === 'turn/start' || e.type === 'turn/end')`；若最后边界是 `turn/start` ⇒ 该 session 有开放回合。`snapshotEvents(fromSeq)` 从尾部窗口取（默认尾部 400 条），窗口内找不到边界再回退全量快照。`quietMs = now - max(所有事件的 time)`，用于 UI 展示"已静默 N 秒"。

宿主侧取数（薄层）：`ctx.get('sessions')?.list()` → `s.id` / `s.snapshotEvents()`；标题尽力从 header fold 取，取不到就不填。

**检查不可用时的策略（fail-open + 记录）**：`sessions` 服务缺失或 API 变化 ⇒ `busy.known:false`，**允许重启**，但在 `restart-status.json` 写 `busyCheck:'unavailable: <原因>'`，并在前端面板显示黄色告警。理由：fail-closed 的失败模式是"重启按钮永久失效且无出路"（D-C 下又删掉了 force），比误切一次更糟。新增 config `busyPolicy: 'block' | 'warn'`，默认 `'block'`；`'warn'` 只提示不阻断。

**前端配合**：面板打开时每 3s 拉 `/status`；`busy.generating` 为真时电源钮禁用并显示"生成中：N 个回答（已静默 Ns）"，提供「等空闲后自动重启」——客户端队列（每 3s 复检，最长 10 分钟，可取消）。队列只发起一次 POST，仍由宿主检查兜底，因此不会绕过 D-C。

### 4.4 单实例守卫（两层 + inflight marker）

**L1 — launcher 命名互斥量**（直接修掉 3 并发事故）：

```powershell
$mutex = New-Object System.Threading.Mutex($false, "Local\DSH-Web-Launcher-$port")
if (-not $mutex.WaitOne(0)) {
  Write-Log 'another launcher holds the mutex -> wait instead of spawning'
  # 只轮询探针；就绪则开浏览器；期间绝不 spawn dsh
  exit 0
}
try { ...正常启动流程... } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
```

**L2 — spawn 前的端口占用者分类**（见 §5.1）：只有 `down`（无人监听）才允许 spawn；`up-dsh` / `up-unknown` / `port-no-response` 一律不 spawn，各自给结论。

**L3 — restart inflight marker**：`restart-inflight.json { instanceId, helperPid, at, ttlMs:90000 }`；TTL 内 `POST /restart` → 409；助手启动后若发现 marker 的 `helperPid` 与自己不符 → 自退（双标签页双击不会出两个助手）。

### 4.5 前端状态机

状态：`idle | busy-blocked | queued | confirming | posting | waiting | nonkill | verifying | ready | aborted | failed | timeout`

| 状态 | 触发/动作 | 退出条件 | UI |
|---|---|---|---|
| `idle` | 面板打开后每 3s 拉 `/status` | 点电源钮 | 两个圆钮 |
| `busy-blocked` | `busy.generating` 为真 | 回合结束 | 电源钮禁用 + "生成中：N 个回答（已静默 Ns）" |
| `queued` | 在 busy-blocked 点「等空闲后自动重启」 | 变空闲 → `confirming`（跳过？见下）；>10min → `timeout`；用户取消 | "排队中…空闲后自动重启" |
| `confirming` | 保存 `savedHref = location.href` | 确认/取消 | 确认弹窗（文案去掉"会中断回答"，改为"当前无生成中的回答"） |
| `posting` | `POST /restart` + nonce 头 | 202 → `waiting`；409 busy → 回 `busy-blocked`（带最新 busy）；409 inflight → 展示剩余 TTL；其他 → `failed` | 「正在移交…」 |
| `waiting` | 每 1s `GET /ping`，失败**不终止** | instanceId 变化 → `verifying`；90s → `timeout` | 「服务重启中… 已等待 Ns」 |
| `nonkill` | 连续 15s instanceId 未变 | instanceId 变化 → `verifying` | 「旧实例尚未停止（助手可能未生效）」+ 日志目录 |
| `verifying` | `GET /status` 一次 | `report.phase='ready'` → `ready`；`'aborted-busy'` → `aborted`；`'failed'/'timeout'` → `failed` | 「核对新实例…」 |
| `ready` | 展示耗时 + `authUrl`（可复制） | 2s 后 `location.replace(savedHref ?? '/')` | 「重启完成（12.4s）」 |
| `aborted` | — | 用户关闭 | 「已取消：检测到新开始的回答（会话 X）」+「重试」 |
| `failed` | 展示 `report.error` / `hint` / 日志尾部 | 重试/关闭 | 红色面板 |
| `timeout` | 慢轮询（5s） | 就绪或取消 | 「仍在等待…可继续等待或手动刷新」 |

`ready` 里**同时**展示 `authUrl` 与「若页面要求重新认证，请打开此 URL」——F2 说通常用不到，但 cookie 过期/换 home 时这是唯一自救入口，成本近乎为零。

### 4.6 新增/修改签名

```ts
// src/core/launcher.ts —— 纯函数
export interface LauncherSpec { dshCommand: string; url: string; port: number; profile?: string; iconPath?: string }
export interface RestartSpec {
  port: number; hostPid: number; graceMs: number
  dshCommand: string; profile?: string
  scriptsDir: string; dshHome: string
}
export function renderRestartHelper(spec: RestartSpec): string   // PowerShell（L1/L2 共用）
export function renderProbeFunctions(port: number): string       // 分级探针，被 launcher 与助手共用
export function renderLauncherScript(platform, spec): string     // 重写 win32 分支

// src/core/status.ts —— 纯函数
export type ProbeClass = 'up-dsh' | 'up-unknown' | 'port-no-response' | 'down'
export function classifyProbe(input: { reachable: boolean; status?: number; bodyHead?: string }): ProbeClass
export function tailLines(text: string, n: number): string
export function parseStatusFile(text: string): { ok: true; value: unknown } | { ok: false; error: string }

// src/core/busy.ts —— 纯函数（§4.3）
export function findOpenTurns(sessions: readonly SessionView[], now: number): OpenTurn[]

// src/index.ts —— 副作用薄层
function instanceIdentity(): { instanceId: string; nonce: string; pid: number; port: number; startedAt: string }
function readStatusFile(path: string): { report: unknown; ageMs: number; readError: string | null }
function portOwner(port: number): { listening: boolean; ownerPid?: number; ownerName?: string; isSelf: boolean }
async function spawnSurvivor(helperPath: string, args: string[]): Promise<{ pid: number; method: 'detached' | 'schtasks' }>
function busySnapshot(now: number): BusySnapshot   // 读 ctx.get('sessions')，异常降级为 known:false
```

`renderRestartHelper` / `classifyProbe` / `parseStatusFile` / `tailLines` / `findOpenTurns` 全是**无 IO 纯函数**——沿用现有 `core/launcher.ts` 已有的性质，测试成本极低。

---

## 5. ② 设计

### 5.1 探针分级与分类

替换现有 `Test-DshUrl`（它把 2xx–4xx 都算就绪，既分不清"别的程序占了 3080"，也会把僵死 DSH 当就绪）：

```
Tier 0  TCP 连接（TcpClient.ConnectAsync，500ms）
        失败 → down（无人监听，允许 spawn）
Tier 1  GET /api/dsh-desktop_quick_launcher/ping（1.5s）
        200 且 body.plugin 匹配 → up-dsh（附 instanceId）
        404/401/其他 → 继续 Tier 2（是 DSH 但没本插件/版本旧）
Tier 2  GET /（1.5s）
        401 且 body 含 'dsh web authentication required' → up-dsh（F4 指纹）
        任意 2xx/3xx/4xx → up-unknown（别的程序）
Tier 3  连接建立但两个请求都无响应 → port-no-response（僵死实例）
```

`up-unknown` 与 `port-no-response` 必须携带占用者 PID/进程名（`Get-NetTCPConnection` → `Get-Process`）——这是消息框里最有用的字段。

### 5.2 子进程输出捕获

```powershell
$dshProcess = Start-Process -FilePath $command.Source -ArgumentList $arguments `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $childOut -RedirectStandardError $childErr
```

早退/超时时 `childTail = tailLines(childErr + childOut, 15)`，同时进消息框与状态文件。**② 里单项收益最大的改动**。

### 5.3 失败分类表

| id | 触发 | 消息（zh） | hint | 级别 |
|---|---|---|---|---|
| `mutex-held` | 拿不到 L1 互斥量 | 另一个启动流程正在进行，已改为等待 | 就绪后会自动打开 | info |
| `up-dsh` | 探针 = up-dsh | 服务已在运行，直接打开 | — | ok |
| `up-unknown` | 探针 = up-unknown | 端口 <port> 被 <name> (pid) 占用，它不是 DSH | 结束该进程或改 `url` 换端口 | **error** |
| `port-no-response` | TCP 通、HTTP 无响应 | 端口已被占用但无响应（疑似僵死实例） | 用「停止 DSH」或任务管理器结束 pid | **error** |
| `dsh-not-found` | `Get-Command` 三级回退全空 | 找不到 dsh 命令：<cmd> | 附 `where.exe dsh` 输出 + PATH 是否含 `C:\nvm4w\nodejs` | **error** |
| `child-exit` | 子进程早退 | DSH 启动后退出（代码 X） | + `childTail` 15 行 | **error** |
| `timeout-alive` | 150s 未就绪、进程仍活 | 进程在跑但 150s 内未响应（疑似卡在插件加载） | + `childTail`；建议 `--patch` 逐个排查 | **error** |
| `timeout-dead` | 150s 未就绪、进程已退 | 进程已退出且未就绪 | + `childTail` | **error** |
| `auth-needed` | 探针 401（非失败） | 服务在运行但需要认证 | 打开 `dsh web` 打印的带 token URL | warn |

### 5.4 状态文件 schema

`launcher-status.json`（launcher.ps1 每轮至少写 3 次：`invoked` → 分类结果 → 终态）：

```json
{
  "schema": 1,
  "updatedAt": "2026-09-10T09:31:02.000Z",
  "phase": "ready",
  "probe": { "class": "up-dsh", "status": 200, "checkedAt": "…" },
  "port": { "listening": true, "ownerPid": 22084, "ownerName": "node" },
  "child": { "pid": 31872, "exitCode": null, "outLog": "…", "errLog": "…", "tail": "" },
  "mutex": { "acquired": true, "waitedForExisting": false },
  "message": "服务已就绪，已打开浏览器",
  "hint": ""
}
```

`restart-status.json`（助手写，宿主也可写 `aborted-busy`）：

```json
{
  "schema": 1,
  "updatedAt": "2026-09-10T09:31:20.000Z",
  "phase": "ready",
  "instanceIdBefore": "4f1c…",
  "hostPid": 22084,
  "helperPid": 31872,
  "helperMethod": "detached",
  "busyCheck": "sessions",
  "busyAtHandoff": { "generating": false, "openTurns": [] },
  "killed": [{ "pid": 22084, "name": "node", "reason": "graceful-exit-timeout" }],
  "spawned": { "pid": 31901, "command": "C:\\nvm4w\\nodejs\\dsh.cmd", "args": ["web", "--no-open"] },
  "ready": { "instanceId": "9ab3…", "pid": 31901, "waitedMs": 12400 },
  "authUrl": "http://127.0.0.1:3080/?token=…",
  "childTail": "",
  "error": "",
  "hint": ""
}
```

`phase` 取值：`handoff | verifying-old | killing | spawning | ready | timeout | failed | aborted-busy`。

### 5.5 GUI 呈现

- 默认仍两个圆钮（不侵占界面）；生成中时电源钮禁用（§4.3）。
- 点**图标钮** = 生成/刷新图标 + 打开详情 popover（不再只闪 toast）。
- popover：实例信息（pid/port/uptime/pluginVersion）→ busy 状态 → 上次启动报告 → 上次重启报告 → 日志尾部（可复制）+ 日志目录。
- **一次性横幅**：加载后 `GET /status`，若 `launcher.report.phase` 属错误类且 `ageMs < 24h`，弹「上次桌面图标启动失败：<message>」+「详情」/「关闭」（同一 `updatedAt` 只提示一次，`localStorage` 记 hash）。**这是 ② 真正的兑现点**：失败在下次打开 GUI 时主动浮出来。

---

## 6. 文件级改动清单

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/core/launcher.ts` | 扩 `LauncherSpec`（+`port`）；重写 win32 分支（分级探针、互斥量、输出重定向、状态文件、分类消息）；新增 `renderRestartHelper` / `renderProbeFunctions` / `RestartSpec` | 大（~220 → ~470 行） |
| `src/core/status.ts` | **新增**：`ProbeClass` / `classifyProbe` / `tailLines` / `parseStatusFile` | 中（~120 行） |
| `src/core/busy.ts` | **新增**：`findOpenTurns` + 类型（纯函数，§4.3） | 小（~90 行） |
| `src/index.ts` | instance 身份 + nonce、3 条新路由、busy 快照、状态文件读取、`spawnSurvivor`（L1+L2）、inflight marker、双相 busy 检查、`create` 结果落盘 | 中（+~240 行） |
| `src/client.ts` | 状态机（§4.5）、nonce 获取与带头、详情 popover、等待空闲队列、一次性横幅、i18n 扩充 | 中（~285 → ~560 行） |
| `test/launcher.test.mjs` | **新增**：助手脚本必须含 `RedirectStandardOutput`、**必须不含 `taskkill … /T`**、探针分类 | 小 |
| `test/busy.test.mjs` | **新增**：开放回合判定（`turn/start` 结尾、`turn/end` 结尾、空日志、多 session、尾部窗口回退） | 小 |
| `test/status.test.mjs` | **新增**：半写 JSON、schema 不符、`tailLines` 边界 | 小 |
| `package.json` | `version: 0.2.0`；`scripts.test = node --test test/`；`files` **不含** `docs` | 小 |
| `README.md` / `README.zh.md` | API 表（含 nonce）、busy 阻断说明、Troubleshooting 新条目、Known limitations（重启依赖 cookie 存活 / busy 检查不可用时 fail-open） | 小 |
| `cordis.patch.yml`、`scripts/wrap-client.mjs`、`scripts/verify-client.mjs` | **不变** | — |

新增 config（全部可选、带默认值，向后兼容）：`restartGraceMs`（1500）、`restartTimeoutSec`（150）、`busyPolicy`（`'block'`）、`showLaunchReport`（true）。

---

## 7. 验证方案（每步可证伪）

**Step 0 静态门禁**：`pnpm build`（含 wrap + verify-client）、`pnpm typecheck`、`pnpm test`。任一失败即停。

**Step 1 隔离宿主验证（绝不碰正在服务的 3080）**

先零成本预演（不启动服务）：

```powershell
dsh --profile web --patch D:\DSHWorkplace\desktop_quick_launcher\cordis.patch.yml --dump-config
```

再用一次性 `DSH_HOME` + 备用端口启动（命令见 §10），从 stdout 取 `dsh web: http://127.0.0.1:3081/?token=…`，`curl -c jar` 换 cookie，断言：`/ping` 有 `instanceId` 与 `nonce`；`/status` 结构完整且 `port.isSelf === true`；`/status.busy` 至少 `known` 字段存在。

**Step 2 cookie 跨重启存活（验证 F2）**
重启前 `curl -c jar -L "…/?token=…"`；重启后 `curl -b jar -o NUL -w '%{http_code}' http://127.0.0.1:3081/` → 期望 **200**。若 401，则把 `authUrl` 从"兜底"提升为"主路径"，前端文案与流程随之调整。

**Step 3 幸存者实测（真实 3080，唯一有破坏性的一步）**
GUI 点重启。成功判据三条同时成立：① 页面自动回到原会话；② `/status.restart.phase === 'ready'`；③ `helperPid` 已不在进程表。失败判据：`phase` 停在 `verifying-old`/`killing` 且 `restart-helper.log` 无后续行 ⇒ L1 被连带杀死（此时应已自动降级 L2，观察 `helperMethod` 是否为 `schtasks` 且第二次成功）。

**Step 4 并发守卫**
连点 3 次桌面图标：`launcher-status.json` 只有 **1** 次 `mutex.acquired=true` 且发生 spawn，其余 `mutex-held`；浏览器只打开一次；无 `timeout`。

**Step 5 busy 阻断（D1.5 的正向与反向用例，缺一不可）**
- 反向：**空闲时**点重启 → 必须 202 并成功（证明不是"永远拒绝"）。
- 正向：在一个会话里发起一个长回答（例如让我执行一条几十秒的命令），回答生成期间点重启 → 必须 `409 busy`，前端电源钮禁用；`/status.busy.openTurns` 列出该 sessionId。
- 排队：生成期间点「等空闲后自动重启」→ 回答结束后自动完成重启。
- 二次检查：在 202 之后的 grace 窗口内立刻发起新回答 → `restart.report.phase` 必须是 `aborted-busy`，且**实例没有被重启**（instanceId 不变、页面不断线）。

**Step 6 nonce**
`curl -X POST` 不带 `x-dsh-ql-nonce` → 403 `nonce-required`；带 `/ping` 返回的 nonce → 202/200。三个状态变更路由逐一验证。

**Step 7 诊断证伪（端口被外来程序占用）**
`node -e "require('http').createServer((q,s)=>s.end('other')).listen(3080)"` 占位 → 双击图标 → 消息框与 `/status.launcher.report` 都必须是 `up-unknown` 并带该 PID/进程名，且**没有** spawn 新 dsh。

**Step 8 早退诊断**
隔离 home 里把 `dshCommand` 指向一个立即退出的包装脚本 → 断言 `phase='child-exit'`、`child.exitCode` 非空、`child.tail` 非空（证明 §5.2 生效）。

---

## 8. 版本、文档与发布

- `0.1.1 → 0.2.0`：新增路由与 config 全部**可选且带默认值**，不改 `/create` 语义、不删字段。
- 提交序列（每个可独立回滚）：
  1. `core/status.ts` + `core/busy.ts` + 两个测试
  2. `core/launcher.ts` 探针/状态文件/助手渲染 + 测试
  3. `index.ts` ping/status 路由 + busy 快照 + nonce
  4. `index.ts` restart 路由 + 双相检查 + `spawnSurvivor`（L1+L2）
  5. `client.ts` 状态机 + 面板 + 队列 + nonce
  6. README/版本号
- `docs/design-v0.2-restart-and-diagnostics.md`（本文件）不进 npm 包。

---

## 9. 决策记录与遗留项

| # | 事项 | 结论 |
|---|---|---|
| D-A | 幸存者机制 | ✅ **只做 L1 + L2**，L1 失败自动降级 L2 |
| D-B | nonce | ✅ **纳入**；`/ping` 下发，三个状态变更路由校验 |
| D-C | 生成中的回答 | ✅ **硬阻断**（`409 busy`）+ 前端禁用 + 等空闲队列 + 退出前二次检查 |
| R4 | `node --test` + `test/` 目录 | 按默认引入 |
| R5 | 面板形态 | popover，不常驻 |
| R6 | 重启后是否开新浏览器 | 否，仅同标签页 `location.replace` |
| **R8** | busy 检查**不可用**时（`sessions` 服务缺失/API 变化） | 默认 **fail-open + 记录告警**（理由见 §4.3：fail-closed 会让重启永久失效）；如需改为 fail-closed 请说 |
| **R9** | 是否保留 `force:true` 逃生口 | **默认不提供**（遵循 D-C）。但请注意后果：**若某个回合永久卡住（不结束），重启按钮将一直不可用**，只能任务管理器结束进程。是否接受？我建议保留但有明确文案的二次确认 |
| R10 | 排队等待上限 | 10 分钟；超过转 `timeout` 并提示手动重试 |

---

## 10. 附：隔离验证可直接用的命令骨架

```powershell
$repo  = 'D:\DSHWorkplace\desktop_quick_launcher'
$home2 = "$env:USERPROFILE\.dsh-v02test"
New-Item -ItemType Directory -Force -Path $home2 | Out-Null
Copy-Item 'C:\Users\KLEE\.dsh\profiles' -Destination "$home2\profiles" -Recurse -Force

$log = "$env:TEMP\dsh-v02test.out.log"
$env:DSH_HOME = $home2   # 必须先设，再起进程
# --patch 是启动器级标志（F10），必须排在 app 标志之前
Start-Process -FilePath 'C:\nvm4w\nodejs\dsh.cmd' `
  -ArgumentList @('--profile','web','--patch',"$repo\cordis.patch.yml",'--no-open','--port','3081') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError "$env:TEMP\dsh-v02test.err.log" | Out-Null

$url = $null; $deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $url = (Select-String -Path $log -Pattern '^dsh web:\s*(\S+)' | Select-Object -First 1).Matches.Groups[1].Value
} while (-not $url -and (Get-Date) -lt $deadline)
"authUrl=$url"

$base = 'http://127.0.0.1:3081'
$api  = "$base/api/dsh-desktop_quick_launcher"
curl.exe -s -c "$env:TEMP\v02.jar" -L $url -o NUL

# nonce 必须先取（D-B）
$nonce = (curl.exe -s "$api/ping" | ConvertFrom-Json).nonce
"nonce=$nonce"

curl.exe -s "$api/ping"
curl.exe -s "$api/status"                                  # 看 busy / known
curl.exe -s -i -X POST "$api/restart"                      # 期望 403 nonce-required
curl.exe -s -X POST -H "x-dsh-ql-nonce: $nonce" -H 'content-type: application/json' `
  -d '{"reason":"test"}' "$api/restart"                     # 期望 202 或 409 busy
```

注意：隔离实例必须先设 `DSH_HOME` 再起进程；`--port 3081` 与真实的 3080 隔离，验证期间不影响当前这个会话所在的实例。

---

## 11. 实现偏差与验证现状（v0.2.0 落地后补记）

| # | 文档原计划 | 实际实现 | 原因 |
|---|---|---|---|
| 1 | `core/status.ts` 提供 `classifyProbe()` 纯函数并单测 | **未实现**；探针分类只存在于生成的 PowerShell 里 | 只有 launcher/助手需要分类，宿主不做自探测。在 TS 里再写一份是重复逻辑且会变成死代码；改为断言生成脚本的关键标记（指纹串、`/ping` 路径、四种 class、**不含**旧 `Test-DshUrl`）+ **用真实 PowerShell 解析器校验脚本可解析** |
| 2 | `/create` 把结果额外写进 `launcher-status.json` | **未实现**；create 结果只走 HTTP 响应 | 同一份文件会出现两个写入者（launcher 与宿主），而 create 的语义并非一次"启动运行"，混写会污染上次启动报告 |
| 3 | `apply(ctx, config)` 两参 | 增加可选第三参 `hooks?: ApplyHooks`（`spawnSurvivor` / `requestExit`） | 让 202 移交、`aborted-busy` 取消、`forced` 覆盖这些最关键的新逻辑可被自动化测试；生产路径不传该参数 |
| 4 | busy 只门控重启 | busy **同时门控 stop**（`/shutdown` 也校验 nonce + busy） | 与 D-C 的字面要求一致：「不接受切断正在生产的回答」对退出同样成立 |
| 5 | Step 1 在隔离 dsh 实例上验证 | 部分：改为 stub cordis 上下文 + **真实路由处理器**的集成测试（`test/host.test.mjs`）；未启动隔离实例 | 集成测试覆盖围栏 / nonce / busy / inflight / 202 / aborted-busy 全部分支且零副作用 |

**验证现状（诚实版）**：`pnpm typecheck` 通过；`pnpm test` **37/37** 通过，包含
- 生成 PowerShell 的**真实解析器校验**（launcher 与助手两份脚本）；
- 宿主演·真实路由处理器的 12 项集成测试（含 `409 busy`、`409 restart-inflight`、`202` 移交、退出前二次检查写 `aborted-busy` 且不退出、`forced` 覆盖、`busyPolicy: warn`）。

**尚未完成**：在真实 `dsh web` 进程上跑过一次端到端重启（§7 的 Step 3）——那一步会终止当前会话所在的宿主，需要在装有新版本的实例上由 GUI 触发。
