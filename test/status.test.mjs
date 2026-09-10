/**
 * Unit tests for the shared status vocabulary (src/core/status.ts).
 * Run against the built artifact; `pnpm test` builds first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDuration,
  isLauncherFailure,
  parseStatusFile,
  phaseSeverity,
  stripBom,
  tailLines,
} from '../lib/index.mjs'

const good = JSON.stringify({
  schema: 1,
  updatedAt: '2026-09-10T09:31:02.000Z',
  phase: 'child-exit',
  message: 'DSH 启动后退出（代码 1）',
  child: { pid: 123, exitCode: 1, tail: 'TypeError: boom' },
})

test('parseStatusFile accepts a well-formed launcher status', () => {
  const result = parseStatusFile(good)
  assert.equal(result.ok, true)
  assert.equal(result.value.phase, 'child-exit')
  assert.equal(result.value.child.exitCode, 1)
})

test('parseStatusFile strips a UTF-8 BOM (PowerShell 5.1 writes one)', () => {
  assert.equal(stripBom('\uFEFF{}'), '{}')
  const result = parseStatusFile('\uFEFF' + good)
  assert.equal(result.ok, true)
})

test('parseStatusFile tolerates unknown extra fields', () => {
  const extended = JSON.stringify({
    schema: 1,
    updatedAt: 'x',
    phase: 'ready',
    futureField: { nested: [1, 2] },
  })
  const result = parseStatusFile(extended)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.futureField, { nested: [1, 2] })
})

test('parseStatusFile rejects empty, non-JSON, non-object, and wrong schema', () => {
  assert.equal(parseStatusFile('').ok, false)
  assert.equal(parseStatusFile('   ').ok, false)
  assert.equal(parseStatusFile('not json').ok, false)
  assert.equal(parseStatusFile('[]').ok, false)
  assert.equal(parseStatusFile('"str"').ok, false)
  assert.equal(parseStatusFile(JSON.stringify({ schema: 2, updatedAt: 'x', phase: 'ready' })).ok, false)
  assert.equal(parseStatusFile(JSON.stringify({ schema: 1, phase: 'ready' })).ok, false)
  assert.equal(parseStatusFile(JSON.stringify({ schema: 1, updatedAt: 'x' })).ok, false)
  // A truncated write (the reason the writers use temp+rename) must not throw.
  const truncated = good.slice(0, 40)
  const result = parseStatusFile(truncated)
  assert.equal(result.ok, false)
  assert.match(result.error, /invalid JSON/)
})

test('tailLines keeps the last n lines and drops a trailing newline', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc')
  assert.equal(tailLines('a\r\nb\r\nc', 5), 'a\nb\nc')
  assert.equal(tailLines('only', 10), 'only')
  assert.equal(tailLines('', 5), '')
  assert.equal(tailLines('a\nb', 0), '')
  assert.equal(tailLines('a\n\n\n', 3), 'a')
})

test('phaseSeverity classifies both phase enums', () => {
  assert.equal(phaseSeverity('ready'), 'ok')
  assert.equal(phaseSeverity('up-dsh'), 'ok')
  assert.equal(phaseSeverity('child-exit'), 'error')
  assert.equal(phaseSeverity('timeout-alive'), 'error')
  assert.equal(phaseSeverity('up-unknown'), 'error')
  assert.equal(phaseSeverity('failed'), 'error')
  assert.equal(phaseSeverity('aborted-busy'), 'warn')
  assert.equal(phaseSeverity('handoff'), 'info')
  assert.equal(phaseSeverity('starting'), 'info')
  assert.equal(phaseSeverity('something-new'), 'info')
})

test('isLauncherFailure only flags real launch failures', () => {
  assert.equal(isLauncherFailure('child-exit'), true)
  assert.equal(isLauncherFailure('up-unknown'), true)
  assert.equal(isLauncherFailure('ready'), false)
  assert.equal(isLauncherFailure('up-dsh'), false)
  assert.equal(isLauncherFailure('mutex-held'), false)
})

test('formatDuration renders ms, seconds, and minutes', () => {
  assert.equal(formatDuration(820), '820ms')
  assert.equal(formatDuration(12400), '12.4s')
  assert.equal(formatDuration(63000), '1m 03s')
  assert.equal(formatDuration(-1), '—')
  assert.equal(formatDuration(Number.NaN), '—')
})
