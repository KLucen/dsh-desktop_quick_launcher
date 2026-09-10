window.__ModuleLoader__.load({
	id: "dsh-desktop_quick_launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  default: () => client_default,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_client = require("react-dom/client");

// src/core/status.ts
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function tailLines(text, n) {
  if (text === "" || n <= 0) return "";
  const lines = stripBom(text).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";
  return lines.slice(-n).join("\n");
}
function phaseSeverity(phase) {
  switch (phase) {
    case "ready":
    case "up-dsh":
      return "ok";
    case "invoked":
    case "mutex-held":
    case "down":
    case "spawned":
    case "handoff":
    case "verifying-old":
    case "killing":
    case "spawning":
      return "info";
    case "aborted-busy":
      return "warn";
    case "up-unknown":
    case "port-no-response":
    case "dsh-not-found":
    case "child-exit":
    case "timeout-alive":
    case "timeout-dead":
    case "error":
    case "failed":
    case "timeout":
      return "error";
    default:
      return "info";
  }
}
function isLauncherFailure(phase) {
  return phaseSeverity(phase) === "error";
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  const seconds = ms / 1e3;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

// src/client.ts
var API = {
  ping: "/api/dsh-desktop_quick_launcher/ping",
  status: "/api/dsh-desktop_quick_launcher/status",
  create: "/api/dsh-desktop_quick_launcher/create",
  restart: "/api/dsh-desktop_quick_launcher/restart",
  shutdown: "/api/dsh-desktop_quick_launcher/shutdown",
  logs: "/api/dsh-desktop_quick_launcher/logs",
  logsClear: "/api/dsh-desktop_quick_launcher/logs/clear",
  logsOpen: "/api/dsh-desktop_quick_launcher/logs/open",
  options: "/api/dsh-desktop_quick_launcher/options"
};
var NAMESPACE = "desktop-quick-launcher";
var SECTION_ORDER = 60;
var NONCE_HEADER = "x-dsh-ql-nonce";
var STATUS_POLL_MS = 3e3;
var READY_POLL_MS = 1e3;
var READY_TIMEOUT_MS = 9e4;
var QUEUE_TIMEOUT_MS = 10 * 6e4;
var BANNER_KEY = "dsh-quick-launcher-banner";
var name = "dsh-desktop_quick_launcher";
var inject = [];
function lang() {
  return typeof navigator !== "undefined" && /^zh/i.test(navigator.language) ? "zh" : "en";
}
var T = {
  zh: {
    powerTitle: "停止 DSH Web 服务",
    restartTitle: "重启 DSH Web 服务",
    iconTitle: "桌面图标与状态",
    panelTitle: "DSH 启动器",
    details: "详情",
    close: "关闭",
    restartQueued: "等空闲后自动重启",
    cancelQueue: "取消排队",
    confirmStopHead: "停止 DSH Web 服务？",
    confirmStopBody: "宿主进程将被优雅退出，当前页面会断开连接。",
    confirmRestartHead: "重启 DSH Web 服务？",
    confirmRestartBody: "宿主会优雅退出，由独立助手拉起新实例；新实例就绪后本页会自动回到当前会话。",
    confirmForceHead: "强制操作：会中断正在生成的回答",
    confirmForceBody: "检测到有回答正在生成。强制继续会切断它，未完成的回答不会保留。确定要继续吗？",
    cancel: "取消",
    confirmStop: "确认停止",
    confirmRestart: "确认重启",
    confirmForce: "确认强制继续",
    working: "正在移交…",
    waiting: "服务重启中… 已等待",
    verifying: "核对新实例…",
    ready: "重启完成（",
    aborted: "已取消：检测到新开始的回答。",
    nonkill: "旧实例尚未停止（助手可能未生效），仍在等待…",
    timedOut: "等待超时：服务可能仍在启动，可稍后手动刷新页面。",
    failed: "操作失败：",
    busyBlocked: "有回答正在生成",
    busyHint: "生成期间不会执行重启或退出，以免切断回答。",
    noNonce: "无法获取一次性校验码，请刷新页面后重试。",
    errCreate: "生成失败：",
    toastOk: "已生成：",
    toastWarn: "警告：",
    bannerPrefix: "上次桌面图标启动失败：",
    dismiss: "知道了",
    sectionInstance: "实例",
    sectionBusy: "生成状态",
    sectionLaunch: "上次启动报告",
    sectionRestart: "上次重启报告",
    sectionLogs: "日志",
    pid: "PID",
    port: "端口",
    uptime: "运行时长",
    version: "版本",
    generating: "生成中",
    idle: "空闲",
    quiet: "已静默",
    noData: "（暂无记录）",
    tail: "输出尾部",
    busyUnknown: "无法检测，将放行",
    revealHint: "打开下面的目录可查看完整日志",
    hint: "建议",
    busyRefused: "宿主拒绝：当前有回答正在生成。",
    inflightRefused: "已有一次重启正在进行，请稍候。",
    floatingButtons: "右下角悬浮按钮",
    floatingButtonsHint: "三个按钮可以单独显示或隐藏；全部隐藏后右下角不再出现任何按钮。",
    showDetails: "显示「桌面图标 / 详情」按钮",
    showStop: "显示「停止服务」按钮",
    showRestart: "显示「重启服务」按钮",
    logsTitle: "日志与状态文件",
    logsHint: "这些文件都由本插件生成，清空只影响本插件目录。",
    refresh: "刷新",
    openDir: "打开目录",
    clearAll: "全部清空",
    view: "查看",
    clear: "清空",
    missing: "不存在",
    tailOf: "末尾内容：",
    emptyLog: "（空文件）",
    settingFailed: "保存设置失败：",
    logReadFailed: "读取日志失败：",
    logClearFailed: "清空失败：",
    cardOffline: "无法连接插件宿主（/status 无响应），开关状态暂不可用。",
    lastAction: "最近操作：",
    notWritable: "当前连接不允许写入设置（可能是远程访问的内存模式）。"
  },
  en: {
    powerTitle: "Stop the DSH web service",
    restartTitle: "Restart the DSH web service",
    iconTitle: "Desktop icon and status",
    panelTitle: "DSH launcher",
    details: "Details",
    close: "Close",
    restartQueued: "Restart when idle",
    cancelQueue: "Cancel queue",
    confirmStopHead: "Stop the DSH web service?",
    confirmStopBody: "The host process will exit and this page will disconnect.",
    confirmRestartHead: "Restart the DSH web service?",
    confirmRestartBody: "The host exits gracefully and a detached helper starts a new instance; this page returns to the same session once it is ready.",
    confirmForceHead: "Force: this interrupts the answer being generated",
    confirmForceBody: "A turn is currently generating. Continuing cuts it off and the unfinished answer is not kept. Continue?",
    cancel: "Cancel",
    confirmStop: "Stop",
    confirmRestart: "Restart",
    confirmForce: "Force anyway",
    working: "Handing over…",
    waiting: "Restarting… waited",
    verifying: "Checking the new instance…",
    ready: "Restart complete (",
    aborted: "Cancelled: a new answer had started.",
    nonkill: "The old instance is still running (the helper may not have taken effect); still waiting…",
    timedOut: "Timed out: the service may still be starting — try refreshing the page later.",
    failed: "Failed: ",
    busyBlocked: "An answer is being generated",
    busyHint: "Restart and stop stay disabled while generating so the answer is never cut off.",
    noNonce: "Could not obtain the one-time token — refresh the page and retry.",
    errCreate: "Create failed: ",
    toastOk: "Created: ",
    toastWarn: "Warning: ",
    bannerPrefix: "The last desktop-icon launch failed: ",
    dismiss: "Dismiss",
    sectionInstance: "Instance",
    sectionBusy: "Generation",
    sectionLaunch: "Last launch report",
    sectionRestart: "Last restart report",
    sectionLogs: "Logs",
    pid: "PID",
    port: "Port",
    uptime: "Uptime",
    version: "Version",
    generating: "generating",
    idle: "idle",
    quiet: "quiet for",
    noData: "(nothing recorded yet)",
    tail: "Output tail",
    busyUnknown: "undetectable — will allow",
    revealHint: "Open the directory below for the full logs",
    hint: "Hint",
    busyRefused: "Refused: an answer is being generated.",
    inflightRefused: "A restart is already in flight — please wait.",
    floatingButtons: "Floating buttons",
    floatingButtonsHint: "Each button can be shown or hidden; hiding all three removes the floating panel entirely.",
    showDetails: 'Show the "desktop icon / details" button',
    showStop: 'Show the "stop service" button',
    showRestart: 'Show the "restart service" button',
    logsTitle: "Logs and status files",
    logsHint: "All of these files are produced by this plugin; clearing them only affects its own directory.",
    refresh: "Refresh",
    openDir: "Open folder",
    clearAll: "Clear all",
    view: "View",
    clear: "Clear",
    missing: "missing",
    tailOf: "Tail of",
    emptyLog: "(empty file)",
    settingFailed: "Could not save the setting: ",
    logReadFailed: "Could not read the log: ",
    logClearFailed: "Could not clear: ",
    cardOffline: "Cannot reach the plugin host (/status did not answer), so the switches are unavailable.",
    lastAction: "Last action:",
    notWritable: "This connection does not allow settings writes (a remote browser may be in memory mode)."
  }
}[lang()];
var PHASE_TEXT = {
  invoked: { zh: "已启动", en: "started" },
  "mutex-held": { zh: "另一启动流程进行中，已转为等待", en: "another launcher was starting; waited instead" },
  spawned: { zh: "正在启动 dsh", en: "starting dsh" },
  ready: { zh: "成功：服务已就绪并打开浏览器", en: "ok: service ready, browser opened" },
  "up-dsh": { zh: "服务已在运行", en: "service was already running" },
  starting: { zh: "服务已启动，等待 Web 界面就绪", en: "service up, waiting for the Web UI" },
  "up-unknown": { zh: "端口被其他程序占用", en: "the port is held by another program" },
  "port-no-response": { zh: "端口被占用但无响应（疑似僵死实例）", en: "port held but unresponsive (likely a stuck instance)" },
  down: { zh: "端口空闲", en: "port free" },
  "dsh-not-found": { zh: "找不到 dsh 命令", en: "dsh command not found" },
  "child-exit": { zh: "dsh 启动后立即退出", en: "dsh exited right after starting" },
  "timeout-alive": { zh: "进程在跑但一直未响应", en: "process alive but never answered" },
  "timeout-dead": { zh: "未就绪且进程已退出", en: "process exited before becoming ready" },
  error: { zh: "启动流程异常", en: "launcher crashed" },
  handoff: { zh: "已移交重启助手", en: "handed over to the helper" },
  "verifying-old": { zh: "确认旧实例已退出", en: "verifying the old instance is gone" },
  killing: { zh: "兜底清理旧进程", en: "fallback cleanup of the old process" },
  spawning: { zh: "正在启动新实例", en: "starting the new instance" },
  timeout: { zh: "新实例未就绪", en: "the new instance never became ready" },
  failed: { zh: "重启失败", en: "restart failed" },
  "aborted-busy": { zh: "已取消（检测到新回答）", en: "cancelled (a new answer started)" }
};
function phaseLabel(phase) {
  const entry = PHASE_TEXT[phase];
  if (entry === void 0) return phase;
  return lang() === "zh" ? entry.zh : entry.en;
}
async function getJson(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json();
    if (typeof body !== "object" || body === null) return null;
    return body;
  } catch {
    return null;
  }
}
async function postJson(path, payload, nonce) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", [NONCE_HEADER]: nonce },
    body: JSON.stringify(payload)
  });
  let body = {};
  try {
    const parsed = await response.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed;
  } catch {
  }
  return { status: response.status, body };
}
function closeCurrentPage() {
  window.close();
  if (!window.closed) window.location.replace("about:blank");
}
var ROUND_BTN = {
  width: "44px",
  height: "44px",
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,.14)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  color: "#fff",
  boxShadow: "0 4px 14px rgba(0,0,0,.35)"
};
var OVERLAY = {
  position: "fixed",
  inset: "0",
  zIndex: 2147483003,
  background: "rgba(0,0,0,.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center"
};
var DIALOG = {
  background: "#1B1E27",
  color: "#F2F3F5",
  borderRadius: "14px",
  padding: "20px 22px",
  width: "min(380px, 86vw)",
  boxShadow: "0 10px 40px rgba(0,0,0,.5)",
  border: "1px solid rgba(255,255,255,.08)",
  fontSize: "14px",
  lineHeight: 1.6
};
var DIALOG_ACTIONS = { display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "18px" };
var BTN = {
  border: "0",
  borderRadius: "8px",
  padding: "7px 16px",
  cursor: "pointer",
  fontSize: "13px",
  color: "#fff",
  background: "#3a3f4b"
};
var BTN_DANGER = { ...BTN, background: "#E54D4D" };
var BTN_PRIMARY = { ...BTN, background: "#4D6BFE" };
var TOAST = {
  position: "fixed",
  right: "18px",
  bottom: "84px",
  zIndex: 2147483002,
  background: "#1B1E27",
  color: "#F2F3F5",
  border: "1px solid rgba(255,255,255,.1)",
  borderRadius: "10px",
  padding: "8px 12px",
  fontSize: "12px",
  maxWidth: "70vw",
  boxShadow: "0 6px 20px rgba(0,0,0,.4)",
  wordBreak: "break-all",
  whiteSpace: "pre-wrap"
};
var INLINE_NOTE = {
  ...TOAST,
  position: "fixed",
  right: "18px",
  bottom: "150px",
  maxWidth: "min(420px, 90vw)"
};
var PANEL = {
  position: "fixed",
  right: "18px",
  bottom: "78px",
  zIndex: 2147483001,
  width: "min(430px, 92vw)",
  maxHeight: "70vh",
  overflowY: "auto",
  background: "#1B1E27",
  color: "#F2F3F5",
  border: "1px solid rgba(255,255,255,.1)",
  borderRadius: "12px",
  padding: "14px 16px",
  fontSize: "12px",
  lineHeight: 1.65,
  boxShadow: "0 10px 40px rgba(0,0,0,.5)"
};
var BANNER = {
  position: "fixed",
  right: "18px",
  bottom: "84px",
  zIndex: 2147483002,
  maxWidth: "min(420px, 90vw)",
  background: "#2A1E1E",
  color: "#F2F3F5",
  border: "1px solid #E54D4D66",
  borderRadius: "10px",
  padding: "10px 12px",
  fontSize: "12px",
  boxShadow: "0 8px 26px rgba(0,0,0,.45)"
};
var SECTION_TITLE = { fontWeight: 600, marginTop: "10px", color: "#C8CDDA" };
var MUTED = { color: "#9BA1B0" };
var MONO = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "11px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  background: "rgba(255,255,255,.04)",
  borderRadius: "6px",
  padding: "6px 8px",
  margin: "4px 0 0"
};
function PowerGlyph() {
  return (0, import_react.createElement)(
    "svg",
    { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" },
    (0, import_react.createElement)("path", { d: "M12 2v10" }),
    (0, import_react.createElement)("path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0" })
  );
}
function IconGlyph() {
  return (0, import_react.createElement)(
    "svg",
    { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    (0, import_react.createElement)("rect", { x: "2", y: "3", width: "20", height: "13", rx: "2" }),
    (0, import_react.createElement)("path", { d: "M8 21h8M12 16v5" })
  );
}
function RestartGlyph() {
  return (0, import_react.createElement)(
    "svg",
    { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    (0, import_react.createElement)("path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }),
    (0, import_react.createElement)("path", { d: "M21 3v5h-5" })
  );
}
function useModalOpen() {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const check = () => {
      try {
        setOpen(document.querySelector('[aria-modal="true"], dialog[open]') !== null);
      } catch {
        setOpen(false);
      }
    };
    check();
    const id = window.setInterval(check, 600);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return open;
}
function FloatingPanel() {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [nonce, setNonce] = (0, import_react.useState)(null);
  const [detailsOpen, setDetailsOpen] = (0, import_react.useState)(false);
  const [dialog, setDialog] = (0, import_react.useState)(null);
  const [phase, setPhase] = (0, import_react.useState)("idle");
  const [note, setNote] = (0, import_react.useState)("");
  const [toast, setToast] = (0, import_react.useState)(null);
  const [banner, setBanner] = (0, import_react.useState)(null);
  const [working, setWorking] = (0, import_react.useState)(false);
  const savedHref = (0, import_react.useRef)("");
  const beforeId = (0, import_react.useRef)("");
  const timer = (0, import_react.useRef)(null);
  const modalOpen = useModalOpen();
  const flash = (0, import_react.useCallback)((kind, text) => {
    setToast({ kind, text });
    window.setTimeout(() => {
      setToast(null);
    }, 7e3);
  }, []);
  const stopTimer = (0, import_react.useCallback)(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const refresh = (0, import_react.useCallback)(async () => {
    const next = await getJson(API.status);
    if (next !== null) {
      setStatus(next);
      if (typeof next.nonce === "string" && next.nonce !== "") setNonce(next.nonce);
    }
    return next;
  }, []);
  const ensureNonce = (0, import_react.useCallback)(async () => {
    if (nonce !== null) return nonce;
    const next = await getJson(API.ping);
    const value = next?.nonce;
    if (typeof value !== "string" || value === "") {
      flash("err", T.noNonce);
      return null;
    }
    setNonce(value);
    return value;
  }, [flash, nonce]);
  (0, import_react.useEffect)(() => {
    void (async () => {
      const next = await refresh();
      if (next === null) return;
      const report = next.launcher.report;
      if (report === null || !isLauncherFailure(report.phase)) return;
      if (next.launcher.ageMs !== null && next.launcher.ageMs > 24 * 36e5) return;
      let seen = "";
      try {
        seen = window.localStorage.getItem(BANNER_KEY) ?? "";
      } catch {
      }
      if (seen === report.updatedAt) return;
      try {
        window.localStorage.setItem(BANNER_KEY, report.updatedAt);
      } catch {
      }
      setBanner(T.bannerPrefix + phaseLabel(report.phase) + " — " + report.message);
    })();
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    if (phase !== "idle") return;
    const id = window.setInterval(() => {
      void refresh();
    }, STATUS_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [phase, refresh]);
  const generating = status?.busy.generating === true;
  const busyKnown = status?.busy.known !== false;
  const openTurns = status?.busy.openTurns ?? [];
  const verify = (0, import_react.useCallback)(async () => {
    setPhase("verifying");
    const next = await refresh();
    const report = next?.restart.report ?? null;
    if (report === null) {
      setPhase("failed");
      setNote(T.failed + phaseLabel("failed"));
      return;
    }
    if (report.phase === "ready") {
      setPhase("ready");
      const waited = report.ready?.waitedMs;
      setNote(T.ready + (typeof waited === "number" ? formatDuration(waited) : "") + ")");
      window.setTimeout(() => {
        window.location.replace(savedHref.current === "" ? "/" : savedHref.current);
      }, 2e3);
      return;
    }
    if (report.phase === "aborted-busy") {
      setPhase("aborted");
      setNote(T.aborted);
      return;
    }
    setPhase("failed");
    setNote(T.failed + (report.error ?? phaseLabel(report.phase)) + (report.hint === void 0 || report.hint === "" ? "" : `
${T.hint}：${report.hint}`));
  }, [refresh]);
  const waitForReady = (0, import_react.useCallback)(() => {
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > READY_TIMEOUT_MS) {
        setPhase("timeout");
        setNote(T.timedOut);
        return;
      }
      try {
        const response = await fetch(API.ping, { cache: "no-store" });
        if (response.ok) {
          const body = await response.json();
          const info = typeof body === "object" && body !== null ? body : {};
          if (typeof info.nonce === "string" && info.nonce !== "") setNonce(info.nonce);
          if (typeof info.instanceId === "string" && info.instanceId !== beforeId.current) {
            await verify();
            return;
          }
          if (Date.now() - started > 15e3) setPhase("nonkill");
        }
      } catch {
      }
      timer.current = window.setTimeout(() => {
        void tick();
      }, READY_POLL_MS);
    };
    void tick();
  }, [verify]);
  const submit = (0, import_react.useCallback)(async (path, force, restart) => {
    const header = await ensureNonce();
    if (header === null) return;
    savedHref.current = window.location.href;
    beforeId.current = status?.instanceId ?? "";
    setPhase("posting");
    setNote(T.working);
    try {
      const result = await postJson(path, { force }, header);
      if (result.status === 409) {
        setPhase("idle");
        setNote(result.body.code === "busy" ? T.busyRefused : T.inflightRefused);
        void refresh();
        return;
      }
      if (result.status < 200 || result.status >= 300) {
        setPhase("failed");
        setNote(T.failed + String(result.body.error ?? `HTTP ${result.status}`));
        return;
      }
      if (!restart) {
        setPhase("idle");
        setNote("");
        window.setTimeout(closeCurrentPage, 700);
        return;
      }
      setPhase("waiting");
      setNote(`${T.waiting} 0s`);
      waitForReady();
    } catch (error) {
      setPhase("failed");
      setNote(T.failed + (error instanceof Error ? error.message : String(error)));
    }
  }, [ensureNonce, refresh, status, waitForReady]);
  const submitRef = (0, import_react.useRef)(submit);
  (0, import_react.useEffect)(() => {
    submitRef.current = submit;
  }, [submit]);
  (0, import_react.useEffect)(() => {
    if (phase !== "queued") return;
    const started = Date.now();
    const id = window.setInterval(() => {
      void (async () => {
        if (Date.now() - started > QUEUE_TIMEOUT_MS) {
          setPhase("idle");
          setNote(T.timedOut);
          return;
        }
        const next = await getJson(API.status);
        if (next === null) return;
        setStatus(next);
        if (typeof next.nonce === "string" && next.nonce !== "") setNonce(next.nonce);
        if (!next.busy.generating) {
          window.clearInterval(id);
          void submitRef.current(API.restart, false, true);
        }
      })();
    }, STATUS_POLL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [phase]);
  (0, import_react.useEffect)(() => {
    if (phase !== "waiting" && phase !== "nonkill") return;
    const started = Date.now();
    const id = window.setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1e3);
      setNote(phase === "waiting" ? `${T.waiting} ${seconds}s` : T.nonkill);
    }, 1e3);
    return () => {
      window.clearInterval(id);
    };
  }, [phase]);
  (0, import_react.useEffect)(() => () => {
    stopTimer();
  }, [stopTimer]);
  const onCreate = async () => {
    const header = await ensureNonce();
    if (header === null) return;
    setWorking(true);
    try {
      const result = await postJson(API.create, {}, header);
      if (result.status < 200 || result.status >= 300) {
        flash("err", T.errCreate + String(result.body.error ?? `HTTP ${result.status}`));
        return;
      }
      const info = result.body.result ?? {};
      const parts = [T.toastOk, info.path ?? ""];
      if (info.warning !== void 0) parts.push(`
${T.toastWarn}${info.warning}`);
      flash("ok", parts.join(""));
      setDetailsOpen(true);
      void refresh();
    } catch (error) {
      flash("err", T.errCreate + (error instanceof Error ? error.message : String(error)));
    } finally {
      setWorking(false);
    }
  };
  const onConfirm = async () => {
    const kind = dialog;
    setDialog(null);
    if (kind === null) return;
    setWorking(true);
    try {
      if (kind === "stop") await submit(API.shutdown, false, false);
      else if (kind === "restart") await submit(API.restart, false, true);
      else if (kind === "force-stop") await submit(API.shutdown, true, false);
      else await submit(API.restart, true, true);
    } finally {
      setWorking(false);
    }
  };
  const requestOperation = (restart) => {
    setDialog(generating ? restart ? "force-restart" : "force-stop" : restart ? "restart" : "stop");
  };
  const renderReport = (title, phase2, message, hint, tail) => (0, import_react.createElement)(
    "div",
    null,
    (0, import_react.createElement)("div", { style: SECTION_TITLE }, title),
    (0, import_react.createElement)("div", { style: { color: phaseSeverity(phase2) === "error" ? "#E58A8A" : "#C8CDDA" } }, phaseLabel(phase2)),
    message === "" ? null : (0, import_react.createElement)("div", { style: MUTED }, message),
    hint === void 0 || hint === "" ? null : (0, import_react.createElement)("div", { style: MUTED }, `${T.hint}：${hint}`),
    tail === void 0 || tail === "" ? null : (0, import_react.createElement)(
      "div",
      null,
      (0, import_react.createElement)("div", { style: MUTED }, T.tail),
      (0, import_react.createElement)("pre", { style: MONO }, tailLines(tail, 15))
    )
  );
  const launcherReport = status?.launcher.report ?? null;
  const restartReport = status?.restart.report ?? null;
  const config = status?.config;
  const showDetails = config?.showDetailsButton !== false;
  const showStop = config?.showStopButton !== false;
  const showRestart = config?.showRestartButton !== false;
  const busyLine = status === null ? T.noData : status.busy.known ? status.busy.generating ? `${T.generating}: ${openTurns.map((turn) => `${turn.sessionId} #${turn.turn}（${T.quiet} ${formatDuration(turn.quietMs)}）`).join("，")}` : T.idle : `${T.busyUnknown} — ${status.busy.check}`;
  if (modalOpen) return null;
  return (0, import_react.createElement)(
    "div",
    null,
    toast === null ? null : (0, import_react.createElement)("div", {
      style: toast.kind === "err" || toast.kind === "warn" ? { ...TOAST, borderColor: "#E54D4D66" } : TOAST
    }, toast.text),
    banner === null ? null : (0, import_react.createElement)(
      "div",
      { style: BANNER },
      (0, import_react.createElement)("div", null, banner),
      (0, import_react.createElement)(
        "div",
        { style: { marginTop: "8px", display: "flex", gap: "8px" } },
        (0, import_react.createElement)("button", { type: "button", style: BTN, onClick: () => {
          setBanner(null);
          setDetailsOpen(true);
        } }, T.details),
        (0, import_react.createElement)("button", { type: "button", style: BTN, onClick: () => {
          setBanner(null);
        } }, T.dismiss)
      )
    ),
    showDetails || showStop || showRestart ? (0, import_react.createElement)(
      "div",
      { style: { position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483e3, display: "flex", gap: "10px" } },
      !showDetails ? null : (0, import_react.createElement)("button", {
        type: "button",
        style: { ...ROUND_BTN, background: "#4D6BFE" },
        title: T.iconTitle,
        "aria-label": T.iconTitle,
        onClick: () => {
          setDetailsOpen((open) => !open);
          void refresh();
        }
      }, (0, import_react.createElement)(IconGlyph)),
      !showStop ? null : (0, import_react.createElement)("button", {
        type: "button",
        style: { ...ROUND_BTN, background: generating ? "#3a3f4b" : "#E54D4D", opacity: generating ? 0.6 : 1, cursor: generating ? "not-allowed" : "pointer" },
        title: generating ? `${T.busyBlocked} — ${T.busyHint}` : T.powerTitle,
        "aria-label": T.powerTitle,
        disabled: generating,
        onClick: () => {
          if (!generating) requestOperation(false);
        }
      }, (0, import_react.createElement)(PowerGlyph)),
      !showRestart ? null : (0, import_react.createElement)("button", {
        type: "button",
        style: { ...ROUND_BTN, background: generating ? "#3a3f4b" : "#2F7D5B", opacity: generating ? 0.6 : 1, cursor: generating ? "not-allowed" : "pointer" },
        title: generating ? `${T.busyBlocked} — ${T.busyHint}` : T.restartTitle,
        "aria-label": T.restartTitle,
        disabled: generating,
        onClick: () => {
          if (!generating) requestOperation(true);
        }
      }, (0, import_react.createElement)(RestartGlyph))
    ) : null,
    // The persistent "an answer is generating" notice was removed on request:
    // the disabled buttons plus their tooltip carry that information now.
    phase !== "idle" && note !== "" ? (0, import_react.createElement)("div", {
      style: { ...TOAST, bottom: "220px", borderColor: phaseSeverity(phase) === "error" ? "#E54D4D66" : void 0 }
    }, note) : null,
    detailsOpen ? (0, import_react.createElement)(
      "div",
      { style: PANEL },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: "13px" } }, T.panelTitle),
        (0, import_react.createElement)("button", { type: "button", style: BTN, onClick: () => {
          setDetailsOpen(false);
        } }, T.close)
      ),
      status === null ? (0, import_react.createElement)("div", { style: MUTED }, T.noData) : (0, import_react.createElement)(
        "div",
        null,
        (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.sectionInstance),
        (0, import_react.createElement)(
          "div",
          { style: MUTED },
          `${T.pid} ${status.pid} · ${T.port} ${status.port} · ${T.uptime} ${formatDuration(status.uptimeMs)} · ${T.version} ${status.pluginVersion}`
        ),
        (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.sectionBusy),
        (0, import_react.createElement)("div", { style: MUTED }, busyLine),
        launcherReport === null ? (0, import_react.createElement)(
          "div",
          null,
          (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.sectionLaunch),
          (0, import_react.createElement)("div", { style: MUTED }, T.noData)
        ) : renderReport(T.sectionLaunch, launcherReport.phase, launcherReport.message, launcherReport.hint, launcherReport.child?.tail),
        restartReport === null ? (0, import_react.createElement)(
          "div",
          null,
          (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.sectionRestart),
          (0, import_react.createElement)("div", { style: MUTED }, T.noData)
        ) : renderReport(T.sectionRestart, restartReport.phase, restartReport.error ?? "", restartReport.hint, restartReport.childTail),
        (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.sectionLogs),
        (0, import_react.createElement)("div", { style: MUTED }, T.revealHint),
        (0, import_react.createElement)("pre", { style: MONO }, status.logs.dir)
      )
    ) : null,
    dialog === null ? null : (0, import_react.createElement)(
      "div",
      {
        style: OVERLAY,
        onClick: () => {
          if (!working) setDialog(null);
        }
      },
      (0, import_react.createElement)(
        "div",
        {
          style: DIALOG,
          onClick: (event) => {
            event.stopPropagation();
          }
        },
        (0, import_react.createElement)(
          "div",
          { style: { fontWeight: 600, fontSize: "15px" } },
          dialog === "stop" ? T.confirmStopHead : dialog === "restart" ? T.confirmRestartHead : T.confirmForceHead
        ),
        (0, import_react.createElement)(
          "p",
          { style: { margin: "8px 0 0", color: "#9BA1B0", fontSize: "13px" } },
          dialog === "stop" ? T.confirmStopBody : dialog === "restart" ? T.confirmRestartBody : T.confirmForceBody
        ),
        (0, import_react.createElement)(
          "div",
          { style: DIALOG_ACTIONS },
          (0, import_react.createElement)("button", { type: "button", style: BTN, onClick: () => {
            setDialog(null);
          }, disabled: working }, T.cancel),
          (0, import_react.createElement)(
            "button",
            {
              type: "button",
              style: dialog === "stop" || dialog === "restart" ? BTN_PRIMARY : BTN_DANGER,
              onClick: () => {
                void onConfirm();
              },
              disabled: working
            },
            dialog === "stop" ? T.confirmStop : dialog === "restart" ? T.confirmRestart : T.confirmForce
          )
        )
      )
    )
  );
}
var CHECK_ROW = { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0" };
var SMALL_BTN = { ...BTN, padding: "3px 10px", fontSize: "12px" };
var FILE_ROW = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "3px 0",
  borderTop: "1px solid rgba(255,255,255,.06)"
};
function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function LauncherSettingsSection() {
  const [section, setSection] = (0, import_react.useState)({});
  const [note, setNote] = (0, import_react.useState)("");
  const [diagnostic, setDiagnostic] = (0, import_react.useState)("");
  const [files, setFiles] = (0, import_react.useState)([]);
  const [dir, setDir] = (0, import_react.useState)("");
  const [viewing, setViewing] = (0, import_react.useState)(null);
  const [working, setWorking] = (0, import_react.useState)(false);
  const [lastAction, setLastAction] = (0, import_react.useState)("");
  const stamp = () => (/* @__PURE__ */ new Date()).toLocaleTimeString();
  const loadOptions = (0, import_react.useCallback)(async () => {
    const status = await getJson(API.status);
    if (status === null) {
      setDiagnostic(T.cardOffline);
      return;
    }
    setDiagnostic("");
    setSection(status.config ?? {});
  }, []);
  const refreshLogs = (0, import_react.useCallback)(async () => {
    setLastAction(`${T.refresh} ${stamp()}`);
    try {
      const response = await fetch(API.logs, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        setNote(`${T.logReadFailed}HTTP ${response.status}`);
        return;
      }
      const body = await response.json();
      setFiles(Array.isArray(body.files) ? body.files : []);
      setDir(typeof body.dir === "string" ? body.dir : "");
      setNote("");
    } catch (error) {
      setNote(T.logReadFailed + (error instanceof Error ? error.message : String(error)));
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void loadOptions();
    void refreshLogs();
  }, [loadOptions, refreshLogs]);
  (0, import_react.useEffect)(() => {
    const id = window.setInterval(() => {
      void loadOptions();
    }, 3e3);
    return () => {
      window.clearInterval(id);
    };
  }, [loadOptions]);
  const freshNonce = (0, import_react.useCallback)(async () => {
    const next = await getJson(API.ping);
    return next?.nonce ?? null;
  }, []);
  const setFlag = async (field, value) => {
    setNote("");
    setWorking(true);
    setSection((previous) => ({ ...previous, [field]: value }));
    try {
      const header = await freshNonce();
      if (header === null) {
        setNote(T.noNonce);
        await loadOptions();
        return;
      }
      const result = await postJson(API.options, { [field]: value }, header);
      if (result.status < 200 || result.status >= 300) {
        setNote(T.settingFailed + String(result.body.error ?? `HTTP ${result.status}`));
        await loadOptions();
        return;
      }
      setSection(result.body.config ?? {});
    } catch (error) {
      setNote(T.settingFailed + (error instanceof Error ? error.message : String(error)));
      await loadOptions();
    } finally {
      setWorking(false);
    }
  };
  const viewLog = async (name2) => {
    try {
      const response = await fetch(`${API.logs}?name=${encodeURIComponent(name2)}&tail=400`, { cache: "no-store" });
      const body = await response.json();
      setViewing({
        name: name2,
        text: typeof body.text === "string" ? body.text : "",
        size: typeof body.size === "number" ? body.size : 0
      });
    } catch (error) {
      setNote(T.logReadFailed + (error instanceof Error ? error.message : String(error)));
    }
  };
  const clearLogs = async (names) => {
    setLastAction(`${names.length === 0 ? T.clearAll : T.clear} ${stamp()}`);
    const header = await freshNonce();
    if (header === null) {
      setNote(T.noNonce);
      return;
    }
    setWorking(true);
    setNote("");
    try {
      const result = await postJson(API.logsClear, { names }, header);
      if (result.status < 200 || result.status >= 300) setNote(String(result.body.error ?? `HTTP ${result.status}`));
      setViewing(null);
      await refreshLogs();
    } catch (error) {
      setNote(T.logClearFailed + (error instanceof Error ? error.message : String(error)));
    } finally {
      setWorking(false);
    }
  };
  const openDir = async () => {
    setLastAction(`${T.openDir} ${stamp()}`);
    const header = await freshNonce();
    if (header === null) {
      setNote(T.noNonce);
      return;
    }
    try {
      await postJson(API.logsOpen, {}, header);
    } catch {
    }
  };
  const flag = (field, fallback) => typeof section[field] === "boolean" ? section[field] : fallback;
  const disabled = working;
  const toggle = (field, label, fallback) => (0, import_react.createElement)(
    "label",
    { style: CHECK_ROW, key: field },
    (0, import_react.createElement)("input", {
      type: "checkbox",
      checked: flag(field, fallback),
      disabled,
      onChange: (event) => {
        void setFlag(field, event.target.checked);
      }
    }),
    (0, import_react.createElement)("span", null, label)
  );
  return (0, import_react.createElement)(
    "div",
    { style: { fontSize: "13px", lineHeight: 1.7, maxWidth: "640px" } },
    (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.floatingButtons),
    (0, import_react.createElement)("div", { style: MUTED }, T.floatingButtonsHint),
    toggle("showDetailsButton", T.showDetails, true),
    toggle("showStopButton", T.showStop, true),
    toggle("showRestartButton", T.showRestart, true),
    (0, import_react.createElement)("div", { style: SECTION_TITLE }, T.logsTitle),
    (0, import_react.createElement)("div", { style: MUTED }, T.logsHint),
    (0, import_react.createElement)(
      "div",
      { style: { marginTop: "6px", display: "flex", gap: "8px" } },
      (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, onClick: () => {
        void refreshLogs();
      } }, T.refresh),
      (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, onClick: () => {
        void openDir();
      } }, T.openDir),
      (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, disabled: working, onClick: () => {
        void clearLogs([]);
      } }, T.clearAll)
    ),
    (0, import_react.createElement)(
      "div",
      { style: { marginTop: "6px" } },
      files.length === 0 ? (0, import_react.createElement)("div", { style: MUTED }, T.noData) : files.map((file) => (0, import_react.createElement)(
        "div",
        { key: file.name, style: FILE_ROW },
        (0, import_react.createElement)("span", { style: { minWidth: "110px" } }, file.name),
        (0, import_react.createElement)("span", { style: { ...MUTED, minWidth: "72px" } }, file.exists ? formatBytes(file.size) : T.missing),
        (0, import_react.createElement)(
          "span",
          { style: { ...MUTED, flex: 1, fontSize: "11px" } },
          file.exists && file.mtime !== null ? new Date(file.mtime).toLocaleString() : ""
        ),
        (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, disabled: !file.exists, onClick: () => {
          void viewLog(file.name);
        } }, T.view),
        (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, disabled: !file.exists || working, onClick: () => {
          void clearLogs([file.name]);
        } }, T.clear)
      ))
    ),
    dir === "" ? null : (0, import_react.createElement)("pre", { style: MONO }, dir),
    viewing === null ? null : (0, import_react.createElement)(
      "div",
      { style: { marginTop: "10px" } },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px" } },
        (0, import_react.createElement)("span", { style: { fontWeight: 600 } }, `${T.tailOf} ${viewing.name} (${formatBytes(viewing.size)})`),
        (0, import_react.createElement)("button", { type: "button", style: SMALL_BTN, onClick: () => {
          setViewing(null);
        } }, T.close)
      ),
      (0, import_react.createElement)("pre", {
        style: { ...MONO, maxHeight: "260px", overflow: "auto" }
      }, viewing.text === "" ? T.emptyLog : viewing.text)
    ),
    note === "" ? null : (0, import_react.createElement)("div", { style: { marginTop: "8px", color: "#E58A8A" } }, note),
    diagnostic === "" ? null : (0, import_react.createElement)("div", { style: { marginTop: "8px", color: "#E5C07B" } }, diagnostic),
    lastAction === "" ? null : (0, import_react.createElement)("div", { style: { ...MUTED, marginTop: "8px", fontSize: "11px" } }, `${T.lastAction} ${lastAction}`)
  );
}
function registerSettingsSection(ctx) {
  const host = ctx;
  const install = (scoped) => {
    const slots = scoped.slots;
    if (slots === void 0 || typeof slots.register !== "function") return;
    slots.inject("settings.section", () => slots.register({
      name: "settings.section",
      id: NAMESPACE,
      order: SECTION_ORDER,
      label: () => lang() === "zh" ? "DSH 启动器" : "DSH launcher",
      inject: () => ({})
    }, LauncherSettingsSection));
  };
  try {
    if (typeof host.inject === "function") host.inject(["slots"], install);
    else install(host);
  } catch {
  }
}
var mounted = false;
function apply(ctx) {
  if (mounted) return;
  if (typeof document === "undefined") return;
  mounted = true;
  const host = document.createElement("div");
  host.dataset.dshQuickLauncher = "true";
  document.body.appendChild(host);
  const root = (0, import_client.createRoot)(host);
  root.render((0, import_react.createElement)(FloatingPanel));
  registerSettingsSection(ctx);
}
var client_default = { name, inject, apply };

		return module.exports;
	}
});
