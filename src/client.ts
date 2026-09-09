/**
 * desktop-quick-launcher — browser half.
 *
 * A small floating control (bottom-right) independent of the sidebar layout:
 *   - 「生成桌面图标」 POST /api/desktop-quick-launcher/create
 *   - 「停止服务」    POST /api/desktop-quick-launcher/shutdown
 * Deliberately zero client-SDK dependencies: plain fetch + react-dom, styled
 * inline. The Host half enforces the loopback-only fence.
 */

import { createElement, useState, type CSSProperties } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** Same-origin /api surface, spelled to match the Host half. */
const API = {
  create: '/api/desktop-quick-launcher/create',
  shutdown: '/api/desktop-quick-launcher/shutdown',
} as const

export const name = 'desktop-quick-launcher-client'

/** No cordis services are required in the browser. */
export const inject: string[] = []

function lang(): 'zh' | 'en' {
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

const T = {
  zh: {
    title: 'DSH 快速启动',
    create: '生成桌面图标',
    creating: '生成中…',
    shutdown: '停止服务',
    stopping: '停止中…',
    confirmShutdown: '确定要停止 DSH Web 服务吗？当前页面将断开。',
    close: '关闭',
    ok: '已生成：',
    errCreate: '生成失败：',
    errShutdown: '停止请求失败：',
  },
  en: {
    title: 'DSH Quick Launcher',
    create: 'Create desktop icon',
    creating: 'Creating…',
    shutdown: 'Stop service',
    stopping: 'Stopping…',
    confirmShutdown: 'Stop the DSH web service? This page will disconnect.',
    close: 'Close',
    ok: 'Created: ',
    errCreate: 'Create failed: ',
    errShutdown: 'Shutdown request failed: ',
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

const PANEL_STYLE: CSSProperties = {
  position: 'fixed',
  right: '18px',
  bottom: '18px',
  zIndex: 2147483000,
  fontFamily: 'inherit',
  background: '#1B1E27',
  color: '#F2F3F5',
  borderRadius: '14px',
  padding: '12px 14px',
  minWidth: '230px',
  boxShadow: '0 8px 30px rgba(0,0,0,.45)',
  border: '1px solid rgba(255,255,255,.08)',
  fontSize: '13px',
  lineHeight: '1.5',
}
const ROW_STYLE: CSSProperties = { display: 'flex', gap: '8px', marginTop: '8px' }
const BTN_STYLE: CSSProperties = {
  border: '0',
  borderRadius: '8px',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: '12px',
  color: '#fff',
  background: '#4D6BFE',
}
const BTN_DANGER_STYLE: CSSProperties = { ...BTN_STYLE, background: '#E54D4D' }
const STATUS_STYLE: CSSProperties = {
  marginTop: '8px',
  fontSize: '11px',
  color: '#9BA1B0',
  wordBreak: 'break-all',
  maxHeight: '80px',
  overflow: 'auto',
}

interface FloatingState {
  busyCreate: boolean
  busyShutdown: boolean
  status: string
}

function FloatingPanel() {
  const [state, setState] = useState<FloatingState>({ busyCreate: false, busyShutdown: false, status: '' })
  const bump = (patch: Partial<FloatingState>): void => setState(prev => ({ ...prev, ...patch }))

  const onCreate = async (): Promise<void> => {
    if (state.busyCreate) return
    bump({ busyCreate: true, status: '' })
    try {
      const result = await apiCreate()
      const parts = [result.ok ? T.ok : T.errCreate]
      if (result.path !== undefined) parts.push(result.path)
      if (result.warning !== undefined) parts.push(`\n⚠ ${result.warning}`)
      bump({ busyCreate: false, status: parts.join('\n') })
    } catch (error) {
      bump({ busyCreate: false, status: T.errCreate + (error instanceof Error ? error.message : String(error)) })
    }
  }

  const onShutdown = async (): Promise<void> => {
    if (state.busyShutdown) return
    if (!window.confirm(T.confirmShutdown)) return
    bump({ busyShutdown: true, status: '' })
    try {
      await apiShutdown()
      bump({ busyShutdown: false })
      setTimeout(closeCurrentPage, 400)
    } catch (error) {
      bump({ busyShutdown: false, status: T.errShutdown + (error instanceof Error ? error.message : String(error)) })
    }
  }

  return createElement('div', { style: PANEL_STYLE },
    createElement('div', { style: { fontWeight: 600 } }, T.title),
    createElement('div', { style: ROW_STYLE },
      createElement('button', {
        style: BTN_STYLE,
        onClick: () => { void onCreate() },
        disabled: state.busyCreate,
      }, state.busyCreate ? T.creating : T.create),
      createElement('button', {
        style: BTN_DANGER_STYLE,
        onClick: () => { void onShutdown() },
        disabled: state.busyShutdown,
      }, state.busyShutdown ? T.stopping : T.shutdown),
    ),
    state.status !== '' ? createElement('pre', { style: STATUS_STYLE }, state.status) : null,
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
  root.render(createElement(FloatingPanel))
}

export default { name, inject, apply }
