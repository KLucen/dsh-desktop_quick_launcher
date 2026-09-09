/**
 * dsh-desktop_quick_launcher — browser half.
 *
 * A small circular power button pinned to the bottom-right corner of the dsh
 * web page. Clicking it opens a custom confirmation dialog (instead of the
 * native confirm); confirming POSTs /api/dsh-desktop_quick_launcher/shutdown
 * and the host process exits gracefully. A second small button creates or
 * refreshes the desktop launcher icon (POST /create) with an inline toast.
 *
 * Zero client-SDK dependencies: plain fetch + react-dom, inline styles. The
 * Host half enforces the loopback-only fence on both routes.
 */

import { createElement, useState, type CSSProperties } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** Same-origin /api surface, spelled to match the Host half. */
const API = {
  create: '/api/dsh-desktop_quick_launcher/create',
  shutdown: '/api/dsh-desktop_quick_launcher/shutdown',
} as const

export const name = 'dsh-desktop_quick_launcher'

/** No cordis services are required in the browser. */
export const inject: string[] = []

function lang(): 'zh' | 'en' {
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

const T = {
  zh: {
    powerTitle: '停止 DSH Web 服务',
    iconTitle: '生成/刷新桌面图标',
    confirmHead: '停止 DSH Web 服务？',
    confirmBody: '宿主进程将被优雅退出，当前页面会断开连接。正在运行的会话或任务可能中断。',
    cancel: '取消',
    stop: '确认停止',
    stopping: '正在退出…',
    exitSent: '已请求退出，正在断开…',
    errShutdown: '停止请求失败：',
    toastOk: '已生成：',
    toastWarn: '警告：',
    errCreate: '生成失败：',
  },
  en: {
    powerTitle: 'Stop the DSH web service',
    iconTitle: 'Create / refresh desktop icon',
    confirmHead: 'Stop the DSH web service?',
    confirmBody: 'The host process will exit and this page will disconnect. Running sessions or tasks may be interrupted.',
    cancel: 'Cancel',
    stop: 'Stop',
    stopping: 'Stopping…',
    exitSent: 'Exit requested, disconnecting…',
    errShutdown: 'Shutdown request failed: ',
    toastOk: 'Created: ',
    toastWarn: 'Warning: ',
    errCreate: 'Create failed: ',
  },
}[lang()]

interface CreateResult {
  ok: boolean
  path?: string
  warning?: string
}

async function apiCreate(): Promise<CreateResult> {
  const response = await fetch(API.create, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  const result = (body as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) throw new Error('invalid result')
  return result as CreateResult
}

async function apiShutdown(): Promise<void> {
  const response = await fetch(API.shutdown, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

/** Replace the page so the user does not stare at a dead-server error. */
function closeCurrentPage(): void {
  window.close()
  if (!window.closed) window.location.replace('about:blank')
}

// ---- styles (inline) ------------------------------------------------------

const ROUND_BTN: CSSProperties = {
  width: '44px',
  height: '44px',
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,.14)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: '#fff',
  boxShadow: '0 4px 14px rgba(0,0,0,.35)',
}

const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: '0',
  zIndex: 2147483001,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const DIALOG: CSSProperties = {
  background: '#1B1E27',
  color: '#F2F3F5',
  borderRadius: '14px',
  padding: '20px 22px',
  width: 'min(360px, 86vw)',
  boxShadow: '0 10px 40px rgba(0,0,0,.5)',
  border: '1px solid rgba(255,255,255,.08)',
  fontSize: '14px',
  lineHeight: 1.6,
}

const DIALOG_ACTIONS: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }

const BTN: CSSProperties = {
  border: '0',
  borderRadius: '8px',
  padding: '7px 16px',
  cursor: 'pointer',
  fontSize: '13px',
  color: '#fff',
  background: '#3a3f4b',
}

const BTN_DANGER: CSSProperties = { ...BTN, background: '#E54D4D' }

const TOAST: CSSProperties = {
  position: 'fixed',
  right: '18px',
  bottom: '84px',
  zIndex: 2147483002,
  background: '#1B1E27',
  color: '#F2F3F5',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '10px',
  padding: '8px 12px',
  fontSize: '12px',
  maxWidth: '70vw',
  boxShadow: '0 6px 20px rgba(0,0,0,.4)',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
}

// ---- components -----------------------------------------------------------

function PowerGlyph() {
  return createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
    createElement('path', { d: 'M12 2v10' }),
    createElement('path', { d: 'M18.4 6.6a9 9 0 1 1-12.8 0' }),
  )
}

function IconGlyph() {
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    createElement('rect', { x: '2', y: '3', width: '20', height: '13', rx: '2' }),
    createElement('path', { d: 'M8 21h8M12 16v5' }),
  )
}

function FloatingControl() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'sent'>('idle')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  const flash = (kind: 'ok' | 'warn' | 'err', text: string): void => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 7000)
  }

  const onCreate = async (): Promise<void> => {
    try {
      const result = await apiCreate()
      const parts = [result.ok ? T.toastOk : T.errCreate]
      if (result.path !== undefined) parts.push(result.path)
      if (result.warning !== undefined) parts.push(`\n${T.toastWarn}${result.warning}`)
      flash(result.ok ? 'ok' : 'warn', parts.join('\n'))
    } catch (err) {
      flash('err', T.errCreate + (err instanceof Error ? err.message : String(err)))
    }
  }

  const onConfirmStop = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await apiShutdown()
      setPhase('sent')
      setTimeout(closeCurrentPage, 500)
    } catch (err) {
      setBusy(false)
      setPhase('idle')
      setError(T.errShutdown + (err instanceof Error ? err.message : String(err)))
    }
  }

  return createElement('div', null,
    toast === null
      ? null
      : createElement('div', {
        style: toast.kind === 'err' || toast.kind === 'warn' ? { ...TOAST, borderColor: '#E54D4D66' } : TOAST,
      }, toast.text),

    createElement('div', { style: { position: 'fixed', right: '18px', bottom: '18px', zIndex: 2147483000, display: 'flex', gap: '10px' } },
      createElement('button', {
        style: { ...ROUND_BTN, background: '#4D6BFE' },
        title: T.iconTitle,
        'aria-label': T.iconTitle,
        onClick: () => { void onCreate() },
      }, createElement(IconGlyph)),
      createElement('button', {
        style: { ...ROUND_BTN, background: '#E54D4D' },
        title: T.powerTitle,
        'aria-label': T.powerTitle,
        onClick: () => { setConfirmOpen(true) },
      }, createElement(PowerGlyph)),
    ),

    !confirmOpen
      ? null
      : createElement('div', {
        style: OVERLAY,
        onClick: () => { if (!busy) setConfirmOpen(false) },
      },
        createElement('div', {
          style: DIALOG,
          onClick: (e: { stopPropagation(): void }) => { e.stopPropagation() },
        },
          createElement('div', { style: { fontWeight: 600, fontSize: '15px' } }, T.confirmHead),
          createElement('p', { style: { margin: '8px 0 0', color: '#9BA1B0', fontSize: '13px' } }, T.confirmBody),
          error !== '' ? createElement('p', { style: { margin: '10px 0 0', color: '#E54D4D', fontSize: '12px' } }, error) : null,
          phase === 'sent'
            ? createElement('p', { style: { margin: '12px 0 0', color: '#7BC96F' } }, T.exitSent)
            : null,
          createElement('div', { style: DIALOG_ACTIONS },
            createElement('button', { style: BTN, onClick: () => { if (!busy) setConfirmOpen(false) }, disabled: busy }, T.cancel),
            createElement('button', {
              style: BTN_DANGER,
              onClick: () => { void onConfirmStop() },
              disabled: busy,
            }, busy ? T.stopping : T.stop),
          ),
        ),
      ),
  )
}

let mounted = false

/**
 * Mount the floating control once into document.body.
 * @param _ctx - client root context (unused; kept for loader compatibility).
 */
export function apply(_ctx: unknown): void {
  if (mounted) return
  if (typeof document === 'undefined') return
  mounted = true
  const host = document.createElement('div')
  host.dataset.dshQuickLauncher = 'true'
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(createElement(FloatingControl))
}

export default { name, inject, apply }
