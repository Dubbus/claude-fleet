import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Git, ResumeValue, Row, Snapshot } from '../types'

const PANE = 'fleet'
const snapshot = atom({ plugin: 'fleet', key: 'snapshot' } as const, null)
const isOpen = atom({ plugin: 'fleet', key: 'isOpen' } as const, false)
const selected = atom({ plugin: 'fleet', key: 'selected' } as const, null)
const pendingClose = atom({ plugin: 'fleet', key: 'pendingClose' } as const, null)

const TICK_MS = 5000
// The status line only needs the registry; git and token reads run only while the pane is open.
const STATUS_EVERY_TICKS = 3
const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Prompt-cache lifetime: 5 minutes on the API by default, 1 hour on some plans.
// Past it, resuming a session pays to cache its whole context again.
const CACHE_TTL_MS = 60 * 60 * 1000
// How long a `/fleet kill` stays armed for its confirming second run.
const ARM_MS = 60 * 1000
// Context size comes from the last reply, so the tail of the transcript is enough.
const TAIL_BYTES = 1_000_000
const EXPORT_MAX_BYTES = 80 * 1024 * 1024
// Session titles: the opening prompts come from the head, the latest from the tail.
const HEAD_BYTES = 300_000
const TITLES_KEY = 'titles'
const TITLES_PER_SCAN = 2
// Handoffs summarize at most this much of a transcript (head kept for the goal, the rest from the end).
const HANDOFF_INPUT_CHARS = 400_000
const HANDOFF_HEAD_CHARS = 60_000
// A second press of x within this window closes the selected session.
const CLOSE_CONFIRM_MS = 10_000
// After a handoff, one press of x within this window closes that session.
const AFTER_HANDOFF_MS = 20_000

// Claude Code writes one <pid>.json per running session here. It is an internal
// file, not an API: read only the fields below and never the rest (it holds tokens).
const REGISTRY_DIR = '.claude/sessions'
const PROJECTS_DIR = '.claude/projects'

type Registered = { pid: number; name: string; isNamed: boolean; status: string; cwd: string; sessionId: string; updatedAt: number }
type TitleEntry = { title: string; size: number; value?: ResumeValue }
type Armed = { args: string; pids: number[]; at: number }

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const tokensText = (n: number | null) =>
  n === null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

const label = (row: Row) => (row.isNamed ? row.name : row.title ?? row.name)

const VALUE_GLYPH: Record<ResumeValue, string> = { active: '●', reference: '◐', light: '○' }
const VALUE_COLOR: Record<ResumeValue, string | undefined> = { active: 'green', reference: 'yellow', light: undefined }
const VALUE_WORD: Record<ResumeValue, string> = { active: 'in progress', reference: 'finished', light: 'light' }

const glyph = (row: Row) => (row.value ? VALUE_GLYPH[row.value] : ' ')

// Safe to close: idle, and either cold with nothing unfinished, or idle for a week and not known to be in progress.
const isClosable = (row: Row, now: number) =>
  row.pid !== null && !row.isSelf && row.status === 'idle' &&
  ((isCold(row, now) && (row.value === 'light' || row.value === 'reference')) || (isStale(row, now) && row.value !== 'active'))

// The same conversation resumed in two terminals shows up as two processes with one sessionId.
const windowCounts = (rows: Row[]) => {
  const counts = new Map<string, number>()
  for (const r of rows) if (r.sessionId) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1)
  return counts
}

// Fits the label to `width`, keeping a ×N marker visible by shortening the label instead.
const fitLabel = (row: Row, counts: Map<string, number>, width: number) => {
  const n = counts.get(row.sessionId) ?? 1
  if (n <= 1) return fit(label(row), width)
  const mark = ` ×${n}`
  return (fit(label(row), width - mark.length).trimEnd() + mark).padEnd(width)
}

const isStale = (row: Row, now: number) => row.status === 'idle' && now - row.updatedAt > STALE_MS

const isCold = (row: Row, now: number) => row.pid !== null && now - row.updatedAt > CACHE_TTL_MS

const needsYou = (status: string) => status !== 'idle' && status !== 'busy' && status !== 'worktree'

// Claude Code's project folder name: every character outside [A-Za-z0-9] becomes '-'.
const transcriptPath = (home: string, row: Row) =>
  `${home}/${PROJECTS_DIR}/${row.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${row.sessionId}.jsonl`

// The registry is internal to Claude Code, so a release can move or reshape it.
// Every way it can fail says why, rather than showing an empty fleet.
const readRegistry = async ($: EngineInterface): Promise<{ sessions: Registered[]; problem: string | null }> => {
  const home = await $.env.get('HOME')
  // CLAUDE_FLEET_REGISTRY points fleet at another registry folder (a moved one, or a test fixture).
  const override = await $.env.get('CLAUDE_FLEET_REGISTRY')
  if (!home && !override) return { sessions: [], problem: "HOME isn't set, so fleet can't find ~/.claude/sessions." }
  const dir = override || `${home}/${REGISTRY_DIR}`
  const shown = override || `~/${REGISTRY_DIR}`
  if (!(await $.fs.exists(dir))) {
    return { sessions: [], problem: `No ${shown} folder: this Claude Code version may keep its session list elsewhere.` }
  }

  const found: Registered[] = []
  let files = 0
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    files += 1
    try {
      const raw = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`)))
      if (typeof raw.pid !== 'number' || typeof raw.cwd !== 'string') continue
      found.push({
        pid: raw.pid,
        name: String(raw.name ?? raw.sessionId ?? raw.pid),
        // 'derived' names are Claude Code's own (folder + suffix); anything else the person set.
        isNamed: typeof raw.nameSource === 'string' && raw.nameSource !== 'derived',
        status: String(raw.status ?? 'unknown'),
        cwd: raw.cwd,
        sessionId: String(raw.sessionId ?? ''),
        updatedAt: Number(raw.updatedAt ?? entry.mtimeMs),
      })
    } catch {
      // A file mid-write or from another version: skip it this tick.
    }
  }
  if (files === 0) return { sessions: [], problem: `${shown} is empty, though this session is running: the registry may have moved.` }
  if (found.length === 0) {
    return { sessions: [], problem: `Couldn't read any of the ${files} files in ${shown}: their format may have changed.` }
  }

  // Registry files outlive crashed processes; keep only the pids still running.
  const ps = await $.process.run(['ps', '-o', 'pid=', '-p', found.map(r => r.pid).join(',')], { timeoutMs: 3000 })
  const alive = new Set(ps.stdout.split('\n').map(line => Number(line.trim())).filter(Boolean))
  // This session is always running, so nothing alive means ps itself failed.
  if (alive.size === 0) return { sessions: [], problem: `Couldn't check which sessions are running (ps: ${ps.stderr.trim() || `exit ${ps.exitCode}`}).` }
  return { sessions: found.filter(r => alive.has(r.pid)), problem: null }
}

const gitStatus = async ($: EngineInterface, cwd: string): Promise<Git | null> => {
  const r = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 3000 })
  if (r.exitCode !== 0) return null

  const git: Git = { branch: '?', dirty: 0, ahead: 0, behind: 0, hasUpstream: false }
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) git.branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.ab ')) {
      const [, a, b] = line.match(/\+(\d+) -(\d+)/) ?? []
      git.ahead = Number(a ?? 0)
      git.behind = Number(b ?? 0)
      git.hasUpstream = true
    } else if (line && !line.startsWith('#')) git.dirty += 1
  }
  return git
}

// path -> { size, tokens }: a transcript is re-read only when it has grown.
const tokenCache = new Map<string, { size: number; tokens: number | null }>()

const contextTokens = async ($: EngineInterface, path: string): Promise<number | null> => {
  if (!(await $.fs.exists(path))) return null
  const { size } = await $.fs.stat(path)
  const hit = tokenCache.get(path)
  if (hit && hit.size === size) return hit.tokens

  const r = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3000 })
  let tokens: number | null = null
  for (const line of r.stdout.split('\n').reverse()) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const u = entry.message?.usage
      if (!u) continue
      tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      break
    } catch {
      // The first line of a tail is usually cut mid-entry.
    }
  }
  tokenCache.set(path, { size, tokens })
  return tokens
}

// Worktrees of this session's repo that no session is sitting in.
const idleWorktrees = async ($: EngineInterface, taken: Set<string>): Promise<string[]> => {
  const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: await $.session.cwd(), timeoutMs: 3000 })
  if (r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(path => !taken.has(path))
}

// CLAUDE_FLEET_DEMO=1: a fixed, made-up fleet for screenshots and trying the pane safely.
// Demo rows have no transcripts and their pids aren't Claude processes, so no action can touch anything.
const DEMO_PREFIX = 'demo-'

const demoRows = (now: number): Row[] => {
  const m = 60_000
  const d = 24 * 60 * m
  const git = (branch: string, dirty = 0, ahead = 0): Git => ({ branch, dirty, ahead, behind: 0, hasUpstream: true })
  const row = (
    n: number, title: string, status: string, cwd: string, idleMs: number, tokens: number | null,
    value: ResumeValue | null, g: Git | null, extra: Partial<Row> = {},
  ): Row => ({
    key: `pid:${90000 + n}`, name: `demo-${n}`, isNamed: false, title, value, status,
    cwd: `/home/dev/${cwd}`, pid: 90000 + n, sessionId: `${DEMO_PREFIX}${n}`,
    updatedAt: now - idleMs, isSelf: false, git: g, tokens, ...extra,
  })
  return [
    row(1, 'Payments webhook retry bug', 'waiting', 'api', 2 * m, 141_000, 'active', git('fix/webhooks', 1)),
    row(0, 'Auth middleware refactor', 'busy', 'api', 0, 182_000, 'active', git('feat/auth', 4, 2), { isSelf: true }),
    row(2, 'Onboarding copy rewrite', 'busy', 'web', 20_000, 58_000, 'active', git('feat/onboarding', 6, 1)),
    row(3, 'Flaky checkout test triage', 'idle', 'web', 25 * m, 96_000, 'active', git('main', 2)),
    row(4, 'Release notes for v2.4', 'idle', 'docs', 3 * d, 44_000, 'reference', git('main')),
    row(5, 'Regex for ISO dates', 'idle', 'web', 2 * d, 14_000, 'light', git('main')),
    row(6, 'Docker build cache question', 'idle', 'infra', 9 * d, 21_000, 'light', git('main')),
    row(7, 'Postgres migration dry run', 'idle', 'api', 12 * d, 338_000, 'reference', git('master', 0, 2)),
    row(8, 'GraphQL schema review', 'idle', 'api', 30 * d, 212_000, 'reference', git('main'), { sessionId: `${DEMO_PREFIX}8` }),
    row(9, 'GraphQL schema review', 'idle', 'api', 31 * d, 212_000, 'reference', git('main'), { sessionId: `${DEMO_PREFIX}8` }),
    {
      key: 'wt:/home/dev/api-hotfix', name: '(no session)', isNamed: true, title: null, value: null, status: 'worktree',
      cwd: '/home/dev/api-hotfix', pid: null, sessionId: '', updatedAt: 0, isSelf: false, git: git('hotfix/rate-limit'), tokens: null,
    },
  ]
}

const scan = async ($: EngineInterface, isFull: boolean) => {
  if (await $.env.get('CLAUDE_FLEET_DEMO')) {
    const now = await $.clock.now()
    const demo: Snapshot = { rows: demoRows(now), scannedAt: now, warning: null }
    await update($, snapshot, () => demo)
    showStatus($, demo)
    return demo
  }
  const [registry, selfId, now, home, titles] = await Promise.all([
    readRegistry($), $.session.id(), $.clock.now(), $.env.get('HOME'), readTitles($),
  ])
  const sessions = registry.sessions

  const rows: Row[] = sessions.map(s => ({
    key: `pid:${s.pid}`,
    name: s.name,
    isNamed: s.isNamed,
    title: titles[s.sessionId]?.title ?? null,
    value: titles[s.sessionId]?.value ?? null,
    status: s.status,
    cwd: s.cwd,
    pid: s.pid,
    sessionId: s.sessionId,
    updatedAt: s.updatedAt,
    isSelf: s.sessionId === selfId,
    git: null,
    tokens: null,
  }))

  if (isFull) {
    const taken = new Set(rows.map(r => r.cwd))
    for (const path of await idleWorktrees($, taken)) {
      rows.push({
        key: `wt:${path}`, name: '(no session)', isNamed: true, title: null, value: null, status: 'worktree', cwd: path,
        pid: null, sessionId: '', updatedAt: 0, isSelf: false, git: null, tokens: null,
      })
    }
    const byCwd = new Map<string, Promise<Git | null>>()
    for (const row of rows) if (!byCwd.has(row.cwd)) byCwd.set(row.cwd, gitStatus($, row.cwd))
    for (const row of rows) {
      row.git = await byCwd.get(row.cwd)!
      if (home && row.sessionId) row.tokens = await contextTokens($, transcriptPath(home, row))
    }
  } else {
    // Keep the last readings so the pane doesn't flicker between full scans.
    const prev = new Map(((await read($, snapshot))?.rows ?? []).map(r => [r.key, r]))
    for (const row of rows) {
      row.git = prev.get(row.key)?.git ?? null
      row.tokens = prev.get(row.key)?.tokens ?? null
    }
  }

  // Needs-you first, then busy, then most recently active.
  const rank = (r: Row) => (needsYou(r.status) ? 0 : r.status === 'busy' ? 1 : r.status === 'worktree' ? 3 : 2)
  rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)

  const warning =
    registry.problem ??
    (rows.some(r => r.isSelf) ? null : "This session isn't in ~/.claude/sessions, so the list may be incomplete.")
  const next: Snapshot = { rows, scannedAt: now, warning }
  await update($, snapshot, () => next)
  showStatus($, next)
  if (isFull && home) void refreshTitles($, home, rows, titles).catch(() => undefined)
  return next
}

const showStatus = ($: EngineInterface, snap: Snapshot) => {
  if (snap.warning) return $.ui.status("⧉ fleet can't read sessions (/fleet)")
  const live = snap.rows.filter(r => r.pid !== null)
  if (live.length <= 1) return $.ui.status(undefined)
  const busy = live.filter(r => r.status === 'busy').length
  const waiting = live.filter(r => needsYou(r.status)).length
  const parts = [`⧉ ${live.length} sessions`]
  if (busy) parts.push(`${busy} busy`)
  if (waiting) parts.push(`${waiting} need you`)
  $.ui.status(parts.join(' · '))
}

// Headline counts, then the details; the pane draws them as two lines.
const summaryParts = (snap: Snapshot): [string, string] => {
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

const summary = (snap: Snapshot) => summaryParts(snap).filter(Boolean).join(' · ')

const gitText = (git: Git | null) => {
  if (!git) return '—'
  const marks = [git.dirty ? `✎${git.dirty}` : '', git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : '']
  return [git.branch, ...marks.filter(Boolean)].join(' ')
}

const ctxText = (row: Row, now: number) =>
  row.pid === null ? '' : `${tokensText(row.tokens)}${row.tokens !== null && isCold(row, now) ? ' cold' : ''}`

const tableLine = (r: Row, now: number, hasGit = true, counts = new Map<string, number>()) =>
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

const asTable = (snap: Snapshot) => {
  const counts = windowCounts(snap.rows)
  const hasGit = snap.rows.some(x => x.git)
  return (
    (snap.warning ? `⚠ ${snap.warning}\n\n` : '') +
    `${summary(snap)}\n\n${snap.rows.map(r => tableLine(r, snap.scannedAt, hasGit, counts)).join('\n')}\n\n` +
    `ctx = context the session re-caches on its next message; "cold" = cache expired, so that costs the full amount.` +
    (counts.size && [...counts.values()].some(n => n > 1)
      ? `\n×2 = the same conversation open in two terminals; closing the older one loses nothing.`
      : '') +
    `\n● in progress: worth resuming   ◐ finished: /fleet handoff, then close   ○ light: just close`
  )
}

const staleReport = (snap: Snapshot) => {
  const stale = snap.rows.filter(r => r.pid !== null && !r.isSelf && isStale(r, snap.scannedAt))
  if (stale.length === 0) return 'No sessions idle for more than 7 days.'
  return (
    `${stale.length} sessions idle for more than 7 days:\n\n` +
    `${stale.map(r => `  ${String(r.pid).padStart(6)}  ${tableLine(r, snap.scannedAt, true, windowCounts(snap.rows))}`).join('\n')}\n\n` +
    `/fleet kill closes these (add --save to export each conversation first).`
  )
}

// --- Saving a session's conversation as Markdown ---

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b?.type === 'text').map(b => String(b.text)).join('\n')
      : ''

const cleanUserText = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>(.*?)<\/command-name>/g, '$1')
    .replace(/<command-args>(.*?)<\/command-args>/g, ' $1')
    .replace(/<\/?local-command-stdout>/g, '')
    .trim()

const toolLine = (block: { name?: string; input?: Record<string, unknown> }) => {
  const input = block.input ?? {}
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
  return `- \`${block.name}\`${detail ? `: ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`
}

const toMarkdown = (row: Row, jsonl: string, exportedAt: string) => {
  const out = [
    `# Claude session: ${label(row)}`,
    '',
    `- Folder: \`${row.cwd}\``,
    `- Session: \`${row.sessionId}\` (resume with \`claude --resume ${row.sessionId}\`)`,
    `- Exported: ${exportedAt}`,
    '',
  ]
  let tools: string[] = []
  const flushTools = () => {
    if (tools.length) out.push(...tools, '')
    tools = []
  }

  for (const line of jsonl.split('\n')) {
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain || entry.isMeta) continue

    if (entry.type === 'user') {
      const text = cleanUserText(textOf(entry.message?.content))
      if (!text) continue
      flushTools()
      out.push('## You', '', text, '')
    } else if (entry.type === 'assistant') {
      const content = Array.isArray(entry.message?.content) ? entry.message.content : []
      for (const block of content) {
        if (block?.type === 'tool_use') tools.push(toolLine(block))
        else if (block?.type === 'text' && String(block.text).trim()) {
          flushTools()
          out.push('## Claude', '', String(block.text).trim(), '')
        }
      }
    }
  }
  flushTools()
  return out.join('\n')
}

const readTranscript = async ($: EngineInterface, row: Row) => {
  const home = await $.env.get('HOME')
  if (!home || !row.sessionId) throw new Error('no transcript for this session')
  const source = transcriptPath(home, row)
  if (!(await $.fs.exists(source))) throw new Error('transcript not found')
  if ((await $.fs.stat(source)).size > EXPORT_MAX_BYTES) throw new Error('transcript is over 80 MB')
  return String(await $.fs.read(source))
}

// `<folder>/<prefix>-<title>-<date>.<ext>`, numbered when that name is taken.
const freshPath = async ($: EngineInterface, row: Row, prefix: string, now: Date, ext = 'md') => {
  const slug = label(row).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  const stem = `${row.cwd}/${prefix}-${slug}-${now.toISOString().slice(0, 10)}`
  let target = `${stem}.${ext}`
  for (let n = 2; await $.fs.exists(target); n++) target = `${stem}-${n}.${ext}`
  return target
}

// Conversations can hold secrets; say so when the file would show up in `git status`.
const withGitNote = async ($: EngineInterface, row: Row, target: string) => {
  const ignored = await $.process.run(['git', '-C', row.cwd, 'check-ignore', '-q', target], { timeoutMs: 3000 })
  return ignored.exitCode === 1 ? `${target}  (not git-ignored: check it before committing)` : target
}

const saveSession = async ($: EngineInterface, row: Row): Promise<string> => {
  const jsonl = await readTranscript($, row)
  const now = new Date(await $.clock.now())
  const target = await freshPath($, row, 'claude-context', now)
  await $.fs.write(target, toMarkdown(row, jsonl, now.toISOString()))
  return withGitNote($, row, target)
}

const HANDOFF_SYSTEM = `You write handoff notes so a fresh Claude Code session can continue someone's work without the old transcript.
From the transcript only, write Markdown with these sections, skipping any that would be empty:
## Goal: what the person is trying to get done, in 1-3 sentences.
## Status: what is done, and what was in progress when the transcript ends.
## Decisions: choices made and WHY, including approaches tried and rejected.
## Next steps: concrete open threads, in order.
## Key files and commands: paths, commands and URLs that matter, as a short list.
## Gotchas: preferences the person stated, constraints, and things that broke.
Be specific and factual: names, paths and numbers over generalities. Never invent. At most 700 words.`

const handoffSession = async ($: EngineInterface, row: Row): Promise<string> => {
  const now = new Date(await $.clock.now())
  let text = toMarkdown(row, await readTranscript($, row), now.toISOString())
  if (text.length > HANDOFF_INPUT_CHARS) {
    text =
      text.slice(0, HANDOFF_HEAD_CHARS) +
      '\n\n[… middle of the conversation omitted …]\n\n' +
      text.slice(-(HANDOFF_INPUT_CHARS - HANDOFF_HEAD_CHARS))
  }

  const r = await $.model.complete({ model: 'sonnet', system: HANDOFF_SYSTEM, prompt: text, maxTokens: 3000 })
  if (!r.isAnswered) throw new Error(`the summary call failed (${r.reason})`)

  const target = await freshPath($, row, 'claude-handoff', now, 'txt')
  const doc = [
    `# Handoff: ${label(row)}`,
    '',
    `Written ${now.toISOString().slice(0, 16).replace('T', ' ')} from session \`${row.sessionId}\` in \`${row.cwd}\`.`,
    '',
    `To continue in a fresh session: run \`claude\` in this folder and say "Read ${basename(target)} and pick up where it leaves off."`,
    `The full conversation is still there: \`claude --resume ${row.sessionId}\`.`,
    '',
    r.text.trim(),
    '',
  ].join('\n')
  await $.fs.write(target, doc)
  return withGitNote($, row, target)
}

const findRow = (snap: Snapshot, query: string) =>
  query === ''
    ? snap.rows.find(r => r.isSelf)
    : snap.rows.find(r => r.pid !== null && (String(r.pid) === query || r.name === query || label(r) === query)) ??
      snap.rows.find(r => r.pid !== null && label(r).toLowerCase().includes(query.toLowerCase()))

// --- Closing sessions ---

const killTargets = (snap: Snapshot, isAll: boolean) =>
  snap.rows.filter(r => (isAll ? r.pid !== null && !r.isSelf && r.status === 'idle' : isClosable(r, snap.scannedAt)))

// Pids get reused: only signal a pid that is still a Claude process.
const isClaudeProcess = async ($: EngineInterface, pid: number) => {
  const r = await $.process.run(['ps', '-o', 'command=', '-p', String(pid)], { timeoutMs: 3000 })
  return r.exitCode === 0 && /(^|\/)claude(\s|$)|\/claude\/versions\//.test(r.stdout.trim())
}

const runKill = async ($: EngineInterface, args: string, armed: Armed | null): Promise<[string, Armed | null]> => {
  const words = args.split(/\s+/).filter(Boolean)
  const isAll = words.includes('all')
  const isSave = words.includes('--save')
  const isHandoff = words.includes('--handoff')
  const key = `${isAll ? 'all' : 'closable'}${isSave ? ' --save' : ''}${isHandoff ? ' --handoff' : ''}`
  const snap = await scan($, true)
  const targets = killTargets(snap, isAll)
  const scope = isAll
    ? 'idle sessions'
    : 'sessions safe to close (cold and finished or light, or idle over a week and not in progress)'

  if (targets.length === 0) return [`No ${scope} to close (busy sessions, ones waiting on you, and this one are never closed).`, null]

  const isConfirmed =
    armed !== null && armed.args === key && snap.scannedAt - armed.at < ARM_MS &&
    targets.every(t => armed.pids.includes(t.pid!))

  if (!isConfirmed) {
    const tokens = targets.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    return [
      `This would close ${targets.length} ${scope}` + (tokens ? ` (${tokensText(tokens)} tokens of context):` : ':') + '\n\n' +
        targets.map(r => `  ${String(r.pid).padStart(6)}  ${tableLine(r, snap.scannedAt, true, windowCounts(snap.rows))}`).join('\n') + '\n\n' +
        (isHandoff
          ? 'A handoff summary is written in each folder first (a Sonnet call per session).\n'
          : isSave
            ? 'Each conversation is saved as Markdown in its folder first.\n'
            : 'Add --handoff to write a summary first, or --save for the full conversation.\n') +
        `Run /fleet kill${args ? ` ${args}` : ''} again within 60s to confirm. Conversations stay resumable with claude --resume.`,
      { args: key, pids: targets.map(t => t.pid!), at: snap.scannedAt },
    ]
  }

  const lines: string[] = []
  for (const row of targets) {
    if (!(await isClaudeProcess($, row.pid!))) {
      lines.push(`  skipped ${row.pid} ${row.name}: no longer a Claude process`)
      continue
    }
    try {
      if (isSave) lines.push(`  saved   ${label(row)} → ${await saveSession($, row)}`)
      if (isHandoff) lines.push(`  handoff ${label(row)} → ${await handoffSession($, row)}`)
    } catch (err) {
      lines.push(`  kept    ${row.pid} ${label(row)}: ${(err as Error).message}, so not closed`)
      continue
    }
    const r = await $.process.run(['kill', String(row.pid)], { timeoutMs: 3000 })
    lines.push(r.exitCode === 0 ? `  closed  ${row.pid} ${label(row)}` : `  failed  ${row.pid} ${label(row)}: ${r.stderr.trim()}`)
  }
  void scan($, true)
  return [lines.join('\n'), null]
}

// --- Session titles ---

const readTitles = async ($: EngineInterface) =>
  ((await $.store.get(TITLES_KEY)) ?? {}) as Record<string, TitleEntry>

const userPrompts = (jsonl: string) => {
  const prompts: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"user"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue
      const text = cleanUserText(textOf(entry.message?.content))
      if (text) prompts.push(text.slice(0, 600))
    } catch {
      // A head or tail cut mid-entry.
    }
  }
  return prompts
}

const lastAssistantText = (jsonl: string) => {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue
    try {
      const entry = JSON.parse(lines[i])
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const text = textOf(entry.message?.content).trim()
      if (text) return text
    } catch {
      // Cut mid-entry.
    }
  }
  return ''
}

const cleanTitle = (text: string) =>
  text.split('\n')[0].replace(/^(title:\s*)/i, '').replace(/["'`*#]/g, '').replace(/[.\s]+$/, '').trim().slice(0, 48)

// In flight across scans, so a slow call isn't started twice.
const titling = new Set<string>()

const makeTitle = async ($: EngineInterface, path: string, idleText: string) => {
  const [head, tail] = await Promise.all([
    $.process.run(['head', '-c', String(HEAD_BYTES), path], { timeoutMs: 3000 }),
    $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3000 }),
  ])
  const first = userPrompts(head.stdout).slice(0, 3)
  const latest = userPrompts(tail.stdout).slice(-2).filter(p => !first.includes(p))
  if (first.length === 0) return null
  const lastReply = lastAssistantText(tail.stdout).slice(-800)

  const r = await $.model.complete({
    model: 'haiku',
    system:
      'You label coding sessions for a session list. Reply with JSON only: {"title": string, "value": string}.\n' +
      'title: 3-6 words naming the task, leading with the concrete project and goal ("Canvas lab 2 grading drafts"); ' +
      'no quotes, no trailing punctuation, never the words "session", "conversation" or "chat".\n' +
      'value: whether resuming is worth re-sending the whole conversation. Pick exactly one:\n' +
      '- "light": quick questions or one-off lookups; nothing a fresh session couldn\'t redo in a minute.\n' +
      '- "reference": substantial work whose main task was delivered or answered. This is the DEFAULT for real work. ' +
      'A last reply that offers more help, lists optional next steps, or asks "want me to...?" is still "reference".\n' +
      '- "active": ONLY when work is clearly mid-flight: the last reply stops partway through an implementation, ' +
      'a bug or failing test is still being chased, or the person must answer a question before anything can continue. ' +
      'Sessions idle for weeks are rarely active.',
    prompt: (
      `Opening requests:\n${first.join('\n---\n')}\n\nLatest requests:\n${latest.join('\n---\n') || '(same)'}` +
      `\n\nLast reply (end):\n${lastReply || '(none)'}\n\nIdle for: ${idleText}`
    ).slice(0, 5000),
    maxTokens: 80,
    effort: 'low',
  })
  if (!r.isAnswered) return null
  try {
    const raw = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1))
    const title = cleanTitle(String(raw.title ?? ''))
    const value = ['active', 'reference', 'light'].includes(raw.value) ? (raw.value as ResumeValue) : undefined
    return title ? { title, value } : null
  } catch {
    const title = cleanTitle(r.text)
    return title && !title.includes('{') ? { title, value: undefined } : null
  }
}

// Titles a few untitled sessions per scan, and retitles one whose transcript has doubled.
const refreshTitles = async ($: EngineInterface, home: string, rows: Row[], titles: Record<string, TitleEntry>, limit = TITLES_PER_SCAN) => {
  const now = await $.clock.now()
  const due: { row: Row; path: string; size: number }[] = []
  for (const row of rows) {
    if (!row.sessionId || row.isNamed || titling.has(row.sessionId)) continue
    const path = transcriptPath(home, row)
    if (!(await $.fs.exists(path))) continue
    const { size } = await $.fs.stat(path)
    const known = titles[row.sessionId]
    if (!known || !known.value || size > known.size * 2) due.push({ row, path, size })
    if (due.length >= limit) break
  }

  for (const { row } of due) titling.add(row.sessionId)
  const made = await Promise.all(
    due.map(({ row, path, size }) =>
      makeTitle($, path, ago(now - row.updatedAt).replace('now', 'under a minute'))
        .then(made => (made ? { sessionId: row.sessionId, ...made, size } : null))
        .catch(() => null),
    ),
  )
  for (const { row } of due) titling.delete(row.sessionId)

  const fresh = made.filter(m => m !== null)
  if (fresh.length === 0) return 0
  const all = await readTitles($)
  for (const m of fresh) all[m.sessionId] = { title: m.title, size: m.size, value: m.value }
  await $.store.set(TITLES_KEY, all)
  const byId = new Map(fresh.map(m => [m.sessionId, m]))
  await update($, snapshot, snap =>
    snap && {
      ...snap,
      rows: snap.rows.map(r => {
        const m = byId.get(r.sessionId)
        return m ? { ...r, title: m.title, value: m.value ?? null } : r
      }),
    },
  )
  return fresh.length
}

// --- Pane row actions ---

const selectedRow = async ($: EngineInterface) => {
  const [snap, key] = await Promise.all([read($, snapshot), read($, selected)])
  return snap?.rows.find(r => r.key === key) ?? null
}

const isDemo = (row: Row) => row.sessionId.startsWith(DEMO_PREFIX)

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

const copyResume = async ($: EngineInterface, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  const row = await selectedRow($)
  if (!row) return $.ui.toast('Select a session first (↑/↓)')
  const command = row.sessionId
    ? `cd ${shellQuote(row.cwd)} && claude --resume ${row.sessionId}`
    : `cd ${shellQuote(row.cwd)} && claude`
  const copied = await $.ui.copy({ text: command, surface })
  $.ui.toast(copied.isCopied ? `Copied: ${command}` : command)
}

const saveSelected = async ($: EngineInterface) => {
  const row = await selectedRow($)
  if (!row || row.pid === null) return $.ui.toast('Select a session first (↑/↓)')
  if (isDemo(row)) return $.ui.toast('Demo mode: nothing to do for made-up sessions')
  try {
    $.ui.toast(`Saved → ${await saveSession($, row)}`)
  } catch (err) {
    $.ui.toast(`Couldn't save: ${(err as Error).message}`)
  }
}

const handoffSelected = async ($: EngineInterface) => {
  const row = await selectedRow($)
  if (!row || row.pid === null) return $.ui.toast('Select a session first (↑/↓)')
  if (isDemo(row)) return $.ui.toast('Demo mode: nothing to do for made-up sessions')
  $.ui.toast(`Writing a handoff for ${label(row)}…`)
  let target: string
  try {
    target = await handoffSession($, row)
  } catch (err) {
    return $.ui.toast(`Couldn't write a handoff: ${(err as Error).message}`)
  }

  // The context now lives in the handoff, so offer to close the session with one press.
  if (row.isSelf || row.status !== 'idle') return $.ui.toast(`Handoff → ${target}`)
  await armClose($, row, AFTER_HANDOFF_MS)
  $.ui.toast(`Handoff → ${target} · press x to close the session`)
}

// Marks `row` so the next x closes it, until `ms` pass or another row is armed.
const armClose = async ($: EngineInterface, row: Row, ms: number) => {
  await update($, pendingClose, () => row.key)
  $.clock.after(ms, () => {
    void update($, pendingClose, key => (key === row.key ? null : key))
  })
}

const closeSelected = async ($: EngineInterface) => {
  const row = await selectedRow($)
  if (!row || row.pid === null) return $.ui.toast('Select a session first (↑/↓)')
  if (isDemo(row)) return $.ui.toast('Demo mode: nothing to do for made-up sessions')
  if (row.isSelf) return $.ui.toast("That's this session; quit it with /exit")
  if (row.status !== 'idle') return $.ui.toast(`${label(row)} is ${row.status}; only idle sessions are closed`)

  if ((await read($, pendingClose)) !== row.key) {
    await armClose($, row, CLOSE_CONFIRM_MS)
    return $.ui.toast(`Press x again to close ${label(row)} (h writes a handoff first)`)
  }

  await update($, pendingClose, () => null)
  if (!(await isClaudeProcess($, row.pid))) return $.ui.toast(`${row.pid} is no longer a Claude process; left alone`)
  const r = await $.process.run(['kill', String(row.pid)], { timeoutMs: 3000 })
  $.ui.toast(r.exitCode === 0 ? `Closed ${label(row)}` : `Couldn't close ${label(row)}: ${r.stderr.trim()}`)
  void scan($, true)
}

const openPane = async ($: EngineInterface) => {
  await update($, isOpen, () => true)
  await $.ui.open({ id: PANE, title: 'Fleet', focus: true })
  await scan($, true)
}

const HELP = `/fleet                 open the live pane
/fleet list            print the table
/fleet stale           sessions idle for more than 7 days
/fleet save [pid|name]    export a whole conversation as Markdown in its folder (default: this one)
/fleet handoff [pid|name] write a short summary a fresh session can continue from
/fleet kill [--handoff|--save]      close sessions safe to close (repeat to confirm)
/fleet kill all [--handoff|--save]  close every idle session except this one

● in progress: worth resuming · ◐ finished: hand off, then close · ○ light: just close
/fleet retitle         forget the generated session titles and make new ones

In the pane: ↑/↓ select · h handoff · s save · x close (press twice) · c copy resume command · r refresh`

export const register: Register = on => {
  let armed: Armed | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Every running Claude session: status, branch, context size; save or close them',
      argumentHint: '[list|stale|save [pid]|handoff [pid]|kill [all] [--handoff]|retitle|help]',
    })

    let tick = 0
    $.clock.every(TICK_MS, () => {
      tick += 1
      void (async () => {
        const open = await read($, isOpen)
        if (open || tick % STATUS_EVERY_TICKS === 0) await scan($, open)
      })().catch(() => undefined)
    })
    void scan($, false).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const args = e.args.trim()
    const [sub = '', ...rest] = args.split(/\s+/)
    const arg = rest.join(' ')

    if (sub === 'help') return { text: HELP }
    if (sub === 'retitle') {
      await $.store.delete(TITLES_KEY)
      const home = await $.env.get('HOME')
      const snap = await scan($, true)
      const made = home ? await refreshTitles($, home, snap.rows, {}, Infinity) : 0
      return { text: `Titled ${made} sessions.\n\n${asTable(await scan($, true))}` }
    }
    if (sub === 'list') return { text: asTable(await scan($, true)) }
    if (sub === 'stale') return { text: staleReport(await scan($, true)) }

    if (sub === 'save') {
      const row = findRow(await scan($, true), arg)
      if (!row) return { text: `No session matches "${arg}". /fleet list shows pids and names.` }
      try {
        return { text: `Saved ${row.name} → ${await saveSession($, row)}` }
      } catch (err) {
        return { text: `Couldn't save ${row.name}: ${(err as Error).message}` }
      }
    }

    if (sub === 'handoff') {
      const row = findRow(await scan($, true), arg)
      if (!row) return { text: `No session matches "${arg}". /fleet list shows pids and names.` }
      try {
        return { text: `Handoff for ${label(row)} → ${await handoffSession($, row)}` }
      } catch (err) {
        return { text: `Couldn't write a handoff for ${label(row)}: ${(err as Error).message}` }
      }
    }

    if (sub === 'kill') {
      const [text, nextArmed] = await runKill($, arg, armed)
      armed = nextArmed
      return { text }
    }

    await openPane($)
    return { text: 'Fleet pane opened. /fleet help lists save and kill.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  })

  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && e.element?.startsWith('row:')) {
      const key = e.element.slice('row:'.length)
      await update($, selected, () => key)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <Text dimColor>Scanning…</Text>
    const [picked, closing] = await Promise.all([read($, selected), read($, pendingClose)])

    const now = snap.scannedAt
    const counts = windowCounts(snap.rows)
    const hasGit = snap.rows.some(r => r.git)
    const width = e.props.bodyColumns
    const ctxW = 10
    const projW = Math.max(8, Math.min(20, Math.floor(width * 0.16)))
    const gitW = hasGit ? Math.max(6, Math.min(22, Math.floor(width * 0.2))) : 0
    const nameW = Math.max(10, width - 4 - 9 - projW - gitW - 5 - ctxW - 5)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)

    return (
      <Box flexDirection="column">
        {snap.warning ? <Text color="red" wrap="wrap">⚠ {snap.warning}</Text> : null}
        <Text bold wrap="truncate-end">{summaryParts(snap)[0]}</Text>
        {summaryParts(snap)[1] ? <Text dimColor wrap="truncate-end">{summaryParts(snap)[1]}</Text> : null}
        <Text> </Text>
        {snap.rows.slice(0, room).map((r, i) => {
          const isPicked = r.key === picked
          const stale = r.pid !== null && isStale(r, now)
          const color = r.status === 'busy' ? 'yellow' : needsYou(r.status) && r.pid !== null ? 'red' : undefined
          const cold = r.tokens !== null && isCold(r, now)
          return (
            <Box key={r.key}>
              <Button
                key={`row:${r.key}`}
                plain
                label={isPicked ? '▸' : r.isSelf ? '•' : ' '}
                autoFocus={i === 0 && picked === null ? true : undefined}
                onPress={() => { void update($, selected, () => r.key) }}
              />
              <Text color={r.value ? VALUE_COLOR[r.value] : undefined} dimColor={r.value === 'light'}>{` ${glyph(r)} `}</Text>
              {r.key === closing ? (
                <Text color="red" bold wrap="truncate-end">{fit(`x to close: ${label(r)}`, nameW)} </Text>
              ) : (
                <Text bold={r.isSelf || isPicked} inverse={isPicked} color={r.isSelf ? 'cyan' : undefined} dimColor={stale && !isPicked} wrap="truncate-end">
                  {fitLabel(r, counts, nameW)}
                </Text>
              )}
              <Text> </Text>
              <Text color={color} dimColor={!color}>{fit(r.status, 9)}</Text>
              <Text dimColor={stale}>{fit(basename(r.cwd), projW)} </Text>
              {hasGit ? (
                <Text color={r.git?.dirty ? 'magenta' : undefined} dimColor={!r.git || stale}>{fit(gitText(r.git), gitW)}</Text>
              ) : null}
              <Text dimColor>{(r.pid === null ? '' : ago(now - r.updatedAt)).padStart(4)} </Text>
              <Text color={cold && (r.tokens ?? 0) >= 500_000 ? 'red' : cold ? 'blue' : undefined} dimColor={!cold}>
                {ctxText(r, now).padStart(ctxW)}
              </Text>
            </Box>
          )
        })}
        {snap.rows.length > room ? <Text dimColor>  +{snap.rows.length - room} more (/fleet list)</Text> : null}
        <Text> </Text>
        <Box>
          <Button key="handoff" label="Handoff" hotkey="h" onPress={() => { void handoffSelected($) }} />
          <Text> </Text>
          <Button key="save" label="Save" hotkey="s" onPress={() => { void saveSelected($) }} />
          <Text> </Text>
          <Button key="close" label="Close" hotkey="x" onPress={() => { void closeSelected($) }} />
          <Text> </Text>
          <Button key="copy" label="Copy resume" hotkey="c" onPress={press => { void copyResume($, press.surface) }} />
          <Text> </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => { void scan($, true) }} />
        </Box>
        <Text dimColor wrap="truncate-end">● in progress  ◐ finished: hand off  ○ light · ctx = tokens a resume re-caches · cold = cache expired</Text>
      </Box>
    )
  })
}
