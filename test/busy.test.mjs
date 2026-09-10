/**
 * Unit tests for the open-turn check (src/core/busy.ts).
 *
 * These run against the BUILT artifact (lib/index.mjs) so they exercise exactly
 * what ships. `pnpm test` builds first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findOpenTurns } from '../lib/index.mjs'

const NOW = Date.parse('2026-09-10T09:31:00.000Z')
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString()

test('open turn: last boundary is turn/start', () => {
  const sessions = [{
    id: 'session-1',
    events: [
      { type: 'turn/start', time: at(30), data: { turn: 3 } },
      { type: 'assistant/attempt', time: at(29) },
      { type: 'turn/end', time: at(20), data: { turn: 3 } },
      { type: 'turn/start', time: at(5), data: { turn: 4 } },
      { type: 'assistant/attempt', time: at(2) },
    ],
  }]
  const open = findOpenTurns(sessions, NOW)
  assert.equal(open.length, 1)
  assert.equal(open[0].sessionId, 'session-1')
  assert.equal(open[0].turn, 4)
  assert.equal(open[0].startedAt, at(5))
  assert.equal(open[0].quietMs, 2000)
})

test('closed turn: last boundary is turn/end', () => {
  const sessions = [{
    id: 'session-1',
    events: [
      { type: 'turn/start', time: at(30), data: { turn: 1 } },
      { type: 'turn/end', time: at(10), data: { turn: 1 } },
    ],
  }]
  assert.deepEqual(findOpenTurns(sessions, NOW), [])
})

test('no events at all is not busy', () => {
  assert.deepEqual(findOpenTurns([{ id: 'session-empty', events: [] }], NOW), [])
})

test('events without any turn boundary are not busy', () => {
  const sessions = [{ id: 's', events: [{ type: 'session/header', time: at(9) }] }]
  assert.deepEqual(findOpenTurns(sessions, NOW), [])
})

test('turn number falls back to the event index when data.turn is absent', () => {
  const sessions = [{
    id: 's',
    events: [{ type: 'turn/end' }, { type: 'turn/start' }],
  }]
  const open = findOpenTurns(sessions, NOW)
  assert.equal(open.length, 1)
  assert.equal(open[0].turn, 1)
  assert.equal(open[0].quietMs, 0)
})

test('mixed sessions report only the generating ones, in input order', () => {
  const sessions = [
    { id: 'idle-a', events: [{ type: 'turn/start', time: at(60) }, { type: 'turn/end', time: at(50) }] },
    { id: 'busy-b', events: [{ type: 'turn/start', time: at(4), data: { turn: 2 } }] },
    { id: 'idle-c', events: [] },
    { id: 'busy-d', events: [{ type: 'turn/start', time: at(1), data: { turn: 9 } }] },
  ]
  const open = findOpenTurns(sessions, NOW)
  assert.deepEqual(open.map(turn => turn.sessionId), ['busy-b', 'busy-d'])
  assert.deepEqual(open.map(turn => turn.turn), [2, 9])
})

test('a stale open turn is still reported (the host decides what to do)', () => {
  const sessions = [{ id: 'stuck', events: [{ type: 'turn/start', time: at(7200), data: { turn: 1 } }] }]
  const open = findOpenTurns(sessions, NOW)
  assert.equal(open.length, 1)
  assert.equal(open[0].quietMs, 7200_000)
})
