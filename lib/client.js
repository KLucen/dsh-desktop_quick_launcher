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
var API = {
  create: "/api/dsh-desktop_quick_launcher/create",
  shutdown: "/api/dsh-desktop_quick_launcher/shutdown"
};
var name = "dsh-desktop_quick_launcher";
var inject = [];
function lang() {
  return typeof navigator !== "undefined" && /^zh/i.test(navigator.language) ? "zh" : "en";
}
var T = {
  zh: {
    powerTitle: "停止 DSH Web 服务",
    iconTitle: "生成/刷新桌面图标",
    confirmHead: "停止 DSH Web 服务？",
    confirmBody: "宿主进程将被优雅退出，当前页面会断开连接。正在运行的会话或任务可能中断。",
    cancel: "取消",
    stop: "确认停止",
    stopping: "正在退出…",
    exitSent: "已请求退出，正在断开…",
    errShutdown: "停止请求失败：",
    toastOk: "已生成：",
    toastWarn: "警告：",
    errCreate: "生成失败："
  },
  en: {
    powerTitle: "Stop the DSH web service",
    iconTitle: "Create / refresh desktop icon",
    confirmHead: "Stop the DSH web service?",
    confirmBody: "The host process will exit and this page will disconnect. Running sessions or tasks may be interrupted.",
    cancel: "Cancel",
    stop: "Stop",
    stopping: "Stopping…",
    exitSent: "Exit requested, disconnecting…",
    errShutdown: "Shutdown request failed: ",
    toastOk: "Created: ",
    toastWarn: "Warning: ",
    errCreate: "Create failed: "
  }
}[lang()];
async function apiCreate() {
  const response = await fetch(API.create, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const result = body.result;
  if (typeof result !== "object" || result === null) throw new Error("invalid result");
  return result;
}
async function apiShutdown() {
  const response = await fetch(API.shutdown, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  zIndex: 2147483001,
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
  width: "min(360px, 86vw)",
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
function FloatingControl() {
  const [confirmOpen, setConfirmOpen] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [phase, setPhase] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)("");
  const [toast, setToast] = (0, import_react.useState)(null);
  const flash = (kind, text) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 7e3);
  };
  const onCreate = async () => {
    try {
      const result = await apiCreate();
      const parts = [result.ok ? T.toastOk : T.errCreate];
      if (result.path !== void 0) parts.push(result.path);
      if (result.warning !== void 0) parts.push(`
${T.toastWarn}${result.warning}`);
      flash(result.ok ? "ok" : "warn", parts.join("\n"));
    } catch (err) {
      flash("err", T.errCreate + (err instanceof Error ? err.message : String(err)));
    }
  };
  const onConfirmStop = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiShutdown();
      setPhase("sent");
      setTimeout(closeCurrentPage, 500);
    } catch (err) {
      setBusy(false);
      setPhase("idle");
      setError(T.errShutdown + (err instanceof Error ? err.message : String(err)));
    }
  };
  return (0, import_react.createElement)(
    "div",
    null,
    toast === null ? null : (0, import_react.createElement)("div", {
      style: toast.kind === "err" || toast.kind === "warn" ? { ...TOAST, borderColor: "#E54D4D66" } : TOAST
    }, toast.text),
    (0, import_react.createElement)(
      "div",
      { style: { position: "fixed", right: "18px", bottom: "18px", zIndex: 2147483e3, display: "flex", gap: "10px" } },
      (0, import_react.createElement)("button", {
        style: { ...ROUND_BTN, background: "#4D6BFE" },
        title: T.iconTitle,
        "aria-label": T.iconTitle,
        onClick: () => {
          void onCreate();
        }
      }, (0, import_react.createElement)(IconGlyph)),
      (0, import_react.createElement)("button", {
        style: { ...ROUND_BTN, background: "#E54D4D" },
        title: T.powerTitle,
        "aria-label": T.powerTitle,
        onClick: () => {
          setConfirmOpen(true);
        }
      }, (0, import_react.createElement)(PowerGlyph))
    ),
    !confirmOpen ? null : (0, import_react.createElement)(
      "div",
      {
        style: OVERLAY,
        onClick: () => {
          if (!busy) setConfirmOpen(false);
        }
      },
      (0, import_react.createElement)(
        "div",
        {
          style: DIALOG,
          onClick: (e) => {
            e.stopPropagation();
          }
        },
        (0, import_react.createElement)("div", { style: { fontWeight: 600, fontSize: "15px" } }, T.confirmHead),
        (0, import_react.createElement)("p", { style: { margin: "8px 0 0", color: "#9BA1B0", fontSize: "13px" } }, T.confirmBody),
        error !== "" ? (0, import_react.createElement)("p", { style: { margin: "10px 0 0", color: "#E54D4D", fontSize: "12px" } }, error) : null,
        phase === "sent" ? (0, import_react.createElement)("p", { style: { margin: "12px 0 0", color: "#7BC96F" } }, T.exitSent) : null,
        (0, import_react.createElement)(
          "div",
          { style: DIALOG_ACTIONS },
          (0, import_react.createElement)("button", { style: BTN, onClick: () => {
            if (!busy) setConfirmOpen(false);
          }, disabled: busy }, T.cancel),
          (0, import_react.createElement)("button", {
            style: BTN_DANGER,
            onClick: () => {
              void onConfirmStop();
            },
            disabled: busy
          }, busy ? T.stopping : T.stop)
        )
      )
    )
  );
}
var mounted = false;
function apply(_ctx) {
  if (mounted) return;
  if (typeof document === "undefined") return;
  mounted = true;
  const host = document.createElement("div");
  host.dataset.dshQuickLauncher = "true";
  document.body.appendChild(host);
  const root = (0, import_client.createRoot)(host);
  root.render((0, import_react.createElement)(FloatingControl));
}
var client_default = { name, inject, apply };

		return module.exports;
	}
});
