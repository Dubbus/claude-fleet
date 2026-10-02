import type { Row, Snapshot } from '../../types'

import { CACHE_TTL_MS, DEMO_PREFIX, STALE_MS } from './constants.ts'

export const isStale = (row: Row, now: number) => row.status === 'idle' && now - row.updatedAt > STALE_MS

export const isCold = (row: Row, now: number) => row.pid !== null && now - row.updatedAt > CACHE_TTL_MS

// Anything but working, idle, or a worktree row is a session waiting on the person.
export const needsYou = (status: string) => status !== 'idle' && status !== 'busy' && status !== 'worktree'

// Safe to close: idle, and either cold with nothing unfinished, or idle for a week and not known to be in progress.
export const isClosable = (row: Row, now: number) =>
  row.pid !== null && !row.isSelf && row.status === 'idle' &&
  ((isCold(row, now) && (row.value === 'light' || row.value === 'reference')) || (isStale(row, now) && row.value !== 'active'))

export const killTargets = (snap: Snapshot, isAll: boolean) =>
  snap.rows.filter(r => (isAll ? r.pid !== null && !r.isSelf && r.status === 'idle' : isClosable(r, snap.scannedAt)))

export const isDemo = (row: Row) => row.sessionId.startsWith(DEMO_PREFIX)

// The same conversation resumed in two terminals shows up as two processes with one sessionId.
export const windowCounts = (rows: Row[]) => {
  const counts = new Map<string, number>()
  for (const r of rows) if (r.sessionId) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1)
  return counts
}

// Needs-you first, then busy, then most recently active; worktrees last.
export const sortRows = (rows: Row[]) => {
  const rank = (r: Row) => (needsYou(r.status) ? 0 : r.status === 'busy' ? 1 : r.status === 'worktree' ? 3 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}
