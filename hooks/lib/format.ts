import type { Git, ResumeValue, Row, Snapshot } from '../../types'

import { isClosable, isCold, isStale, needsYou, windowCounts } from './rules.ts'

export const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export const tokensText = (n: number | null) =>
  n === null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

export const label = (row: Row) => (row.isNamed ? row.name : row.title ?? row.name)

export const VALUE_GLYPH: Record<ResumeValue, string> = { active: '●', reference: '◐', light: '○' }
export const VALUE_COLOR: Record<ResumeValue, string | undefined> = { active: 'green', reference: 'yellow', light: undefined }

export const glyph = (row: Row) => (row.value ? VALUE_GLYPH[row.value] : ' ')

// Fits the label to `width`, keeping a ×N marker visible by shortening the label instead.
export const fitLabel = (row: Row, counts: Map<string, number>, width: number) => {
  const n = counts.get(row.sessionId) ?? 1
  if (n <= 1) return fit(label(row), width)
  const mark = ` ×${n}`
  return (fit(label(row), width - mark.length).trimEnd() + mark).padEnd(width)
}

export const gitText = (git: Git | null) => {
  if (!git) return '—'
  const marks = [git.dirty ? `✎${git.dirty}` : '', git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : '']
  return [git.branch, ...marks.filter(Boolean)].join(' ')
}

export const ctxText = (row: Row, now: number) =>
  row.pid === null ? '' : `${tokensText(row.tokens)}${row.tokens !== null && isCold(row, now) ? ' cold' : ''}`

// The status line: counts only, and nothing when this is the only session.
export const statusLineText = (snap: Snapshot) => {
  if (snap.warning) return "⧉ fleet can't read sessions (/fleet)"
  const live = snap.rows.filter(r => r.pid !== null)
  if (live.length <= 1) return undefined
  const busy = live.filter(r => r.status === 'busy').length
  const waiting = live.filter(r => needsYou(r.status)).length
  const parts = [`⧉ ${live.length} sessions`]
  if (busy) parts.push(`${busy} busy`)
  if (waiting) parts.push(`${waiting} need you`)
  return parts.join(' · ')
}

// Headline counts, then the details; the pane draws them as two lines.
export const summaryParts = (snap: Snapshot): [string, string] => {
  const live = snap.rows.filter(r => r.pid !== null)
  const stale = live.filter(r => isStale(r, snap.scannedAt)).length
  const busy = live.filter(r => r.status === 'busy').length
  const cold = live.filter(r => !r.isSelf && isCold(r, snap.scannedAt)).reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  const twice = [...windowCounts(live).values()].filter(n => n > 1).length
  const closable = live.filter(r => isClosable(r, snap.scannedAt)).length
  const waiting = live.filter(r => needsYou(r.status)).length
  const head = [
    `${live.length} sessions`,
    `${busy} busy`,
    waiting ? `${waiting} need you` : '',
    closable ? `${closable} safe to close` : '',
  ]
  const detail = [
    cold ? `${tokensText(cold)} tokens to re-cache` : '',
    stale ? `${stale} idle > 7d` : '',
    twice ? `${twice} open in ${twice === 1 ? 'two windows' : 'several windows'}` : '',
  ]
  return [head.filter(Boolean).join(' · '), detail.filter(Boolean).join(' · ')]
}

export const summary = (snap: Snapshot) => summaryParts(snap).filter(Boolean).join(' · ')

export const tableLine = (r: Row, now: number, hasGit = true, counts = new Map<string, number>()) =>
  [
    r.isSelf ? '▸' : ' ',
    glyph(r),
    fitLabel(r, counts, 34),
    fit(r.status, 9),
    fit(basename(r.cwd), 22),
    hasGit ? fit(gitText(r.git), 22) : '',
    (r.pid === null ? '' : ago(now - r.updatedAt)).padStart(4),
    ctxText(r, now).padStart(11),
  ].join(' ')

// A row prefixed with its pid, for the lists that closing works from.
export const pidLine = (r: Row, snap: Snapshot) =>
  `  ${String(r.pid).padStart(6)}  ${tableLine(r, snap.scannedAt, true, windowCounts(snap.rows))}`

export const asTable = (snap: Snapshot) => {
  const counts = windowCounts(snap.rows)
  const hasGit = snap.rows.some(x => x.git)
  return (
    (snap.warning ? `⚠ ${snap.warning}\n\n` : '') +
    `${summary(snap)}\n\n${snap.rows.map(r => tableLine(r, snap.scannedAt, hasGit, counts)).join('\n')}\n\n` +
    `ctx = context the session re-caches on its next message; "cold" = cache expired, so that costs the full amount.` +
    ([...counts.values()].some(n => n > 1)
      ? `\n×2 = the same conversation open in two terminals; closing the older one loses nothing.`
      : '') +
    `\n● in progress: worth resuming   ◐ finished: /fleet handoff, then close   ○ light: just close`
  )
}

export const staleReport = (snap: Snapshot) => {
  const stale = snap.rows.filter(r => r.pid !== null && !r.isSelf && isStale(r, snap.scannedAt))
  if (stale.length === 0) return 'No sessions idle for more than 7 days.'
  return (
    `${stale.length} sessions idle for more than 7 days:\n\n` +
    `${stale.map(r => pidLine(r, snap)).join('\n')}\n\n` +
    `/fleet kill closes these (add --handoff to write a summary of each first).`
  )
}

// `/fleet save <query>`: no query is this session; otherwise a pid, a name or title, or part of a title.
export const findRow = (snap: Snapshot, query: string) =>
  query === ''
    ? snap.rows.find(r => r.isSelf)
    : snap.rows.find(r => r.pid !== null && (String(r.pid) === query || r.name === query || label(r) === query)) ??
      snap.rows.find(r => r.pid !== null && label(r).toLowerCase().includes(query.toLowerCase()))

export const HELP = `/fleet                    open the live pane
/fleet list               print the table
/fleet stale              sessions idle for more than 7 days
/fleet save [pid|name]    export a whole conversation as Markdown in its folder (default: this one)
/fleet handoff [pid|name] write a short summary a fresh session can continue from
/fleet handoff --fresh    hand off this session, /clear, and continue from the handoff
/fleet handoff --exit     hand off this session, then exit
/fleet kill [--handoff|--save]      close sessions safe to close (repeat to confirm)
/fleet kill all [--handoff|--save]  close every idle session except this one
/fleet retitle            forget the generated session titles and make new ones

● in progress: worth resuming · ◐ finished: hand off, then close · ○ light: just close
In the pane: ↑/↓ select · h handoff · s save · x close (press twice) · c copy resume command · r refresh`
