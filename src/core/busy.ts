/**
 * Open-turn detection: the host-side answer to "is an answer being generated
 * right now?".
 *
 * DSH session logs pair `turn/start` … `turn/end`. A session whose last turn
 * boundary is `turn/start` has an open turn — this is the harness's own
 * definition, used by `@deepseek-ai/dsh-session`'s fork guard
 * (`lib/types/index.js`, `OPEN_TURN`). The plugin reuses that semantic instead
 * of inventing a heuristic, so a restart can be refused BEFORE it interrupts a
 * running answer.
 *
 * Pure module: no node built-ins, no IO — the host passes in event arrays it
 * read from `ctx.sessions.list()`.
 */

/** The only event fields this module needs. */
export interface SessionEventLike {
  type: string
  /** ISO timestamp assigned by the session log. */
  time?: string
  data?: { turn?: number }
}

/** One live session reduced to what the check needs. */
export interface SessionView {
  id: string
  events: readonly SessionEventLike[]
}

/** A session with an unfinished turn. */
export interface OpenTurn {
  sessionId: string
  /** Turn number carried by the `turn/start` event. */
  turn: number
  /** When that turn started (ISO), when the log records it. */
  startedAt: string
  /** Milliseconds since the session's last event; 0 when unknown. */
  quietMs: number
}

const TURN_START = 'turn/start'
const TURN_END = 'turn/end'

function timeOf(event: SessionEventLike | undefined): number | undefined {
  if (event?.time === undefined) return undefined
  const parsed = Date.parse(event.time)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Find every session with an open turn.
 * @param sessions - live sessions as `{ id, events }` (events in log order).
 * @param now - current epoch milliseconds, injected so the result is testable.
 * @returns one entry per generating session, in input order.
 */
export function findOpenTurns(sessions: readonly SessionView[], now: number): OpenTurn[] {
  const open: OpenTurn[] = []
  for (const session of sessions) {
    const events = session.events
    if (events.length === 0) continue

    let boundary: SessionEventLike | undefined
    let boundaryIndex = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const type = events[index].type
      if (type === TURN_START || type === TURN_END) {
        boundary = events[index]
        boundaryIndex = index
        break
      }
    }
    if (boundary === undefined || boundary.type !== TURN_START) continue

    const lastTime = timeOf(events[events.length - 1])
    const startedTime = timeOf(boundary)
    const quietSource = lastTime ?? startedTime
    open.push({
      sessionId: session.id,
      turn: typeof boundary.data?.turn === 'number' ? boundary.data.turn : boundaryIndex,
      startedAt: boundary.time ?? new Date(startedTime ?? now).toISOString(),
      quietMs: quietSource === undefined ? 0 : Math.max(0, now - quietSource),
    })
  }
  return open
}
