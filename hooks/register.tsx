// Everything here touches `$`, which the engine only follows within this one file.
// Pure logic lives in ./lib: rules, formatting, parsing, prompts, demo data and the views.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Armed, Band, Git, Registered, Row, Snapshot, TitleEntry } from '../types'

import {
  AFTER_HANDOFF_MS, ARM_MS, CLOSE_CONFIRM_MS, EXIT_CHECK_TOKENS, EXIT_CONFIRM_MS, EXPORT_MAX_BYTES,
  HANDOFF_AT_TOKENS, HANDOFF_SNOOZE_TOKENS, HEAD_BYTES, MISSING_RETRY_MS, PROJECTS_DIR, REGISTRY_DIR,
  STATUS_EVERY_TICKS, TAIL_BYTES, TICK_MS, TITLES_KEY, TITLES_PER_SCAN,
} from './lib/constants.ts'
import { demoRows } from './lib/demo.ts'
import {
  ago, asTable, basename, findRow, HELP, label, pidLine, shellQuote, staleReport, statusLineText, tokensText,
} from './lib/format.ts'
import {
  lastAssistantText, lastContextTokens, parseGitStatus, parsePids, parseRegistryEntry, parseWorktrees,
  toMarkdown, transcriptPath, userPrompts,
} from './lib/parse.ts'
import { continuePrompt, HANDOFF_SYSTEM, handoffDoc, LABEL_SYSTEM, labelPrompt, parseLabel, trimForHandoff } from './lib/prompts.ts'
import { isDemo, killTargets, needsYou, sortRows } from './lib/rules.ts'
import { bandView, paneView } from './lib/views.tsx'

// Kept here as a literal: hook matchers are read from this file, so an imported id would be opaque.
const PANE = 'fleet'

const snapshot = atom({ plugin: 'fleet', key: 'snapshot' } as const, null)
const isOpen = atom({ plugin: 'fleet', key: 'isOpen' } as const, false)
const selected = atom({ plugin: 'fleet', key: 'selected' } as const, null)
const pendingClose = atom({ plugin: 'fleet', key: 'pendingClose' } as const, null)
const band = atom({ plugin: 'fleet', key: 'band' } as const, null)

// Module state: lost on a reload, which only means asking or caching again.
// path -> { size, tokens }: a transcript is re-read only when it has grown.
const tokenCache = new Map<string, { size: number; tokens: number | null }>()
const transcriptCache = new Map<string, { path: string | null; at: number }>()
// In flight across scans, so a slow title call isn't started twice.
const titling = new Set<string>()
// Set when the person chose to exit, so the next /exit isn't held again.
let exitApproved = false
let exitAskedAt = 0
let snoozedAt = 0

// --- Reading sessions ---

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
      const parsed = parseRegistryEntry(String(await $.fs.read(`${dir}/${entry.name}`)), entry.mtimeMs)
      if (parsed) found.push(parsed)
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
  const alive = parsePids(ps.stdout)
  // This session is always running, so nothing alive means ps itself failed.
  if (alive.size === 0) return { sessions: [], problem: `Couldn't check which sessions are running (ps: ${ps.stderr.trim() || `exit ${ps.exitCode}`}).` }
  return { sessions: found.filter(r => alive.has(r.pid)), problem: null }
}

const gitStatus = async ($: EngineInterface, cwd: string): Promise<Git | null> => {
  const r = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 3000 })
  return r.exitCode === 0 ? parseGitStatus(r.stdout) : null
}

// Worktrees of this session's repo that no session is sitting in.
const idleWorktrees = async ($: EngineInterface, taken: Set<string>): Promise<string[]> => {
  const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: await $.session.cwd(), timeoutMs: 3000 })
  return r.exitCode === 0 ? parseWorktrees(r.stdout).filter(path => !taken.has(path)) : []
}

// Transcripts are filed under the folder a session started in, which can differ from where it is
// now, so fall back to looking for the session's file in every project folder.
const findTranscript = async ($: EngineInterface, home: string, row: Pick<Row, 'cwd' | 'sessionId'>) => {
  if (!row.sessionId) return null
  const direct = transcriptPath(home, row)
  if (await $.fs.exists(direct)) return direct

  const now = await $.clock.now()
  const hit = transcriptCache.get(row.sessionId)
  if (hit && (hit.path ? await $.fs.exists(hit.path) : now - hit.at < MISSING_RETRY_MS)) return hit.path

  let found: string | null = null
  for (const entry of await $.fs.list(`${home}/${PROJECTS_DIR}`)) {
    if (entry.kind !== 'dir') continue
    const path = `${home}/${PROJECTS_DIR}/${entry.name}/${row.sessionId}.jsonl`
    if (await $.fs.exists(path)) {
      found = path
      break
    }
  }
  transcriptCache.set(row.sessionId, { path: found, at: now })
  return found
}

const contextTokens = async ($: EngineInterface, path: string): Promise<number | null> => {
  if (!(await $.fs.exists(path))) return null
  const { size } = await $.fs.stat(path)
  const hit = tokenCache.get(path)
  if (hit && hit.size === size) return hit.tokens

  const r = await $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3000 })
  const tokens = lastContextTokens(r.stdout)
  tokenCache.set(path, { size, tokens })
  return tokens
}

const scan = async ($: EngineInterface, isFull: boolean) => {
  if (await $.env.get('CLAUDE_FLEET_DEMO')) {
    const now = await $.clock.now()
    const demo: Snapshot = { rows: demoRows(now), scannedAt: now, warning: null }
    await update($, snapshot, () => demo)
    $.ui.status(statusLineText(demo))
    return demo
  }
  const [registry, selfId, now, home, titles, previous] = await Promise.all([
    readRegistry($), $.session.id(), $.clock.now(), $.env.get('HOME'), readTitles($), read($, snapshot),
  ])

  const rows: Row[] = registry.sessions.map(s => ({
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
      const path = home ? await findTranscript($, home, row) : null
      if (path) row.tokens = await contextTokens($, path)
    }
  } else {
    // Keep the last readings so the pane doesn't flicker between full scans.
    const prev = new Map((previous?.rows ?? []).map(r => [r.key, r]))
    for (const row of rows) {
      row.git = prev.get(row.key)?.git ?? null
      row.tokens = prev.get(row.key)?.tokens ?? null
    }
  }

  const warning =
    registry.problem ??
    (rows.some(r => r.isSelf) ? null : "This session isn't in ~/.claude/sessions, so the list may be incomplete.")
  const next: Snapshot = { rows: sortRows(rows), scannedAt: now, warning }
  await update($, snapshot, () => next)
  $.ui.status(statusLineText(next))
  if (previous && !previous.warning) await notifyChanges($, previous, next)
  if (isFull && home) void refreshTitles($, home, rows, titles).catch(() => undefined)
  return next
}

// A toast when another session starts waiting on you, or finishes what it was doing.
// CLAUDE_FLEET_NOTIFY=0 turns these off.
const notifyChanges = async ($: EngineInterface, before: Snapshot, after: Snapshot) => {
  if ((await $.env.get('CLAUDE_FLEET_NOTIFY')) === '0') return
  const was = new Map(before.rows.map(r => [r.key, r.status]))
  for (const row of after.rows) {
    const prev = was.get(row.key)
    if (row.isSelf || row.pid === null || prev === undefined || prev === row.status) continue
    if (needsYou(row.status) && !needsYou(prev)) $.ui.toast(`⚠ ${label(row)} needs you (${row.status})`)
    else if (prev === 'busy' && row.status === 'idle') $.ui.toast(`✓ ${label(row)} finished`)
  }
}

// --- Titles and resume value ---

const readTitles = async ($: EngineInterface) =>
  ((await $.store.get(TITLES_KEY)) ?? {}) as Record<string, TitleEntry>

const makeTitle = async ($: EngineInterface, path: string, idleText: string) => {
  const [head, tail] = await Promise.all([
    $.process.run(['head', '-c', String(HEAD_BYTES), path], { timeoutMs: 3000 }),
    $.process.run(['tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 3000 }),
  ])
  const first = userPrompts(head.stdout).slice(0, 3)
  const latest = userPrompts(tail.stdout).slice(-2).filter(p => !first.includes(p))
  if (first.length === 0) return null

  const r = await $.model.complete({
    model: 'haiku',
    system: LABEL_SYSTEM,
    prompt: labelPrompt(first, latest, lastAssistantText(tail.stdout).slice(-800), idleText),
    maxTokens: 80,
    effort: 'low',
  })
  return r.isAnswered ? parseLabel(r.text) : null
}

// Titles a few untitled sessions per scan, and retitles one whose transcript has doubled.
const refreshTitles = async ($: EngineInterface, home: string, rows: Row[], titles: Record<string, TitleEntry>, limit = TITLES_PER_SCAN) => {
  const now = await $.clock.now()
  const due: { row: Row; path: string; size: number }[] = []
  for (const row of rows) {
    if (!row.sessionId || row.isNamed || titling.has(row.sessionId)) continue
    const path = await findTranscript($, home, row)
    if (!path) continue
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

// --- Saving and handing off ---

const readTranscript = async ($: EngineInterface, row: Row) => {
  const home = await $.env.get('HOME')
  if (!home || !row.sessionId) throw new Error('no transcript for this session')
  const source = await findTranscript($, home, row)
  if (!source) throw new Error('transcript not found')
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

const handoffSession = async ($: EngineInterface, row: Row): Promise<string> => {
  const now = new Date(await $.clock.now())
  const text = trimForHandoff(toMarkdown(row, await readTranscript($, row), now.toISOString()))
  const r = await $.model.complete({ model: 'sonnet', system: HANDOFF_SYSTEM, prompt: text, maxTokens: 3000 })
  if (!r.isAnswered) throw new Error(`the summary call failed (${r.reason})`)

  const target = await freshPath($, row, 'claude-handoff', now, 'txt')
  await $.fs.write(target, handoffDoc(row, target, now, r.text))
  return withGitNote($, row, target)
}

// --- Closing sessions ---

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
        targets.map(r => pidLine(r, snap)).join('\n') + '\n\n' +
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
      lines.push(`  skipped ${row.pid} ${label(row)}: no longer a Claude process`)
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

// --- Pane actions on the selected row ---

const selectedRow = async ($: EngineInterface) => {
  const [snap, key] = await Promise.all([read($, snapshot), read($, selected)])
  return snap?.rows.find(r => r.key === key) ?? null
}

// The selected live session, or a toast saying why there isn't one to act on.
const actionableRow = async ($: EngineInterface) => {
  const row = await selectedRow($)
  if (!row || row.pid === null) {
    $.ui.toast('Select a session first (↑/↓)')
    return null
  }
  if (isDemo(row)) {
    $.ui.toast('Demo mode: nothing to do for made-up sessions')
    return null
  }
  return row
}

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
  const row = await actionableRow($)
  if (!row) return
  try {
    $.ui.toast(`Saved → ${await saveSession($, row)}`)
  } catch (err) {
    $.ui.toast(`Couldn't save: ${(err as Error).message}`)
  }
}

// Marks `row` so the next x closes it, until `ms` pass or another row is armed.
const armClose = async ($: EngineInterface, row: Row, ms: number) => {
  await update($, pendingClose, () => row.key)
  $.clock.after(ms, () => {
    void update($, pendingClose, key => (key === row.key ? null : key))
  })
}

const handoffSelected = async ($: EngineInterface) => {
  const row = await actionableRow($)
  if (!row) return
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

const closeSelected = async ($: EngineInterface) => {
  const row = await actionableRow($)
  if (!row || row.pid === null) return
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

// --- This session: offering a handoff before it gets expensive, and before /exit ---

const selfRow = async ($: EngineInterface): Promise<Row> => {
  const [snap, sessionId, cwd, titles] = await Promise.all([read($, snapshot), $.session.id(), $.session.cwd(), readTitles($)])
  const known = snap?.rows.find(r => r.isSelf)
  if (known) return known
  return {
    key: 'self', name: basename(cwd), isNamed: false, title: titles[sessionId]?.title ?? null,
    value: titles[sessionId]?.value ?? null, status: 'busy', cwd, pid: null, sessionId,
    updatedAt: 0, isSelf: true, git: null, tokens: null,
  }
}

const selfTokens = async ($: EngineInterface) => {
  const home = await $.env.get('HOME')
  const row = await selfRow($)
  const path = home ? await findTranscript($, home, row) : null
  return path ? await contextTokens($, path) : null
}

const handoffThreshold = async ($: EngineInterface) => {
  const raw = Number(await $.env.get('CLAUDE_FLEET_HANDOFF_AT'))
  return Number.isFinite(raw) && raw > 0 ? raw : HANDOFF_AT_TOKENS
}

// Runs a built-in command on a timer: a command or press handler that awaits another
// command (or a prompt) directly would wait on itself.
const runLater = ($: EngineInterface, command: string) => {
  $.clock.after(0, () => {
    void $.command.run({ command }).catch(() => $.ui.toast(`fleet: couldn't run /${command}`))
  })
}

const promptLater = ($: EngineInterface, text: string) => {
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch(() => $.ui.toast("fleet: couldn't start the prompt"))
  })
}

const startFresh = ($: EngineInterface, path: string) => {
  void update($, band, () => null)
  runLater($, 'clear')
  // /clear first, then the handoff as the new conversation's first message.
  $.clock.after(500, () => promptLater($, continuePrompt(path)))
}

// Writes a handoff for this session, then optionally starts fresh from it or exits.
const handOffSelf = async ($: EngineInterface, then: 'fresh' | 'exit' | null) => {
  // Whatever happens next, don't offer again until the context grows past this point.
  snoozedAt = (await selfTokens($)) ?? snoozedAt
  await update($, band, () => ({ kind: 'working', text: 'Writing a handoff for this session…' }) satisfies Band)
  let path: string
  try {
    path = (await handoffSession($, await selfRow($))).split('  (')[0]
  } catch (err) {
    await update($, band, () => null)
    $.ui.toast(`Couldn't write a handoff: ${(err as Error).message}`)
    return
  }
  if (then === 'exit') {
    exitApproved = true
    runLater($, 'exit')
  } else if (then === 'fresh') {
    startFresh($, path)
  } else {
    await update($, band, () => ({ kind: 'handedOff', path, then: null }) satisfies Band)
  }
}

// Shows the band's handoff offer when this session's context has passed the threshold.
const checkContext = async ($: EngineInterface) => {
  const [tokens, at, current] = await Promise.all([selfTokens($), handoffThreshold($), read($, band)])
  if (tokens === null || tokens < at || tokens < snoozedAt + HANDOFF_SNOOZE_TOKENS) return
  if (current && current.kind !== 'context') return
  await update($, band, () => ({ kind: 'context', tokens }) satisfies Band)
}

// --- Hooks ---

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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || (await $.env.get('CLAUDE_FLEET_DEMO'))) return result
    $.clock.after(0, () => {
      void checkContext($).catch(() => undefined)
    })
    return result
  })

  // /exit: when this session has work in progress or a big context, offer a handoff first.
  on('command.run', { command: 'exit' }, async ($, e, next) => {
    const now = await $.clock.now()
    if (exitApproved || now - exitAskedAt < EXIT_CONFIRM_MS || (await $.env.get('CLAUDE_FLEET_EXIT_CHECK')) === '0') {
      return next(e)
    }
    const [row, tokens] = await Promise.all([selfRow($), selfTokens($)])
    const isWorthIt = row.value === 'active' || (tokens ?? 0) >= EXIT_CHECK_TOKENS
    if (!isWorthIt) return next(e)

    exitAskedAt = now
    await update($, band, () => ({ kind: 'exit', tokens: tokens ?? 0, value: row.value }) satisfies Band)
    const why = row.value === 'active' ? 'is still in progress' : `holds ${tokensText(tokens)} tokens of context`
    return {
      text:
        `This session ${why}.\n` +
        `  /fleet handoff --exit   write a handoff, then exit\n` +
        `  /exit                   exit anyway (within 30s)\n` +
        `The band above the prompt has the same choices (ctrl+x then Tab, or click it).`,
    }
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')

    if (sub === 'help') return { text: HELP }
    if (sub === 'list') return { text: asTable(await scan($, true)) }
    if (sub === 'stale') return { text: staleReport(await scan($, true)) }

    if (sub === 'retitle') {
      await $.store.delete(TITLES_KEY)
      const home = await $.env.get('HOME')
      const snap = await scan($, true)
      const made = home ? await refreshTitles($, home, snap.rows, {}, Infinity) : 0
      return { text: `Titled ${made} sessions.\n\n${asTable(await scan($, true))}` }
    }

    if (sub === 'save') {
      const row = findRow(await scan($, true), arg)
      if (!row) return { text: `No session matches "${arg}". /fleet list shows pids and names.` }
      try {
        return { text: `Saved ${label(row)} → ${await saveSession($, row)}` }
      } catch (err) {
        return { text: `Couldn't save ${label(row)}: ${(err as Error).message}` }
      }
    }

    if (sub === 'handoff' && (arg === '--fresh' || arg === '--exit')) {
      // Deferred: handing off this session ends in /clear or /exit, which can't run inside this command.
      $.clock.after(0, () => {
        void handOffSelf($, arg === '--fresh' ? 'fresh' : 'exit')
      })
      return {
        text: arg === '--fresh'
          ? 'Writing a handoff, then clearing this session and continuing from it…'
          : 'Writing a handoff, then exiting…',
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const offer = await read($, band)
    if (!offer || e.props.hasSurvey) return next(e)
    return bandView($.ui.resolve(e), offer, {
      handOff: then => { void handOffSelf($, then) },
      startFresh: path => startFresh($, path),
      exitNow: () => {
        exitApproved = true
        runLater($, 'exit')
      },
      later: tokens => {
        snoozedAt = tokens
        void update($, band, () => null)
      },
      dismiss: () => { void update($, band, () => null) },
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [snap, picked, closing] = await Promise.all([read($, snapshot), read($, selected), read($, pendingClose)])
    return paneView(
      $.ui.resolve(e),
      { snap, picked, closing, columns: e.props.bodyColumns, rows: e.viewport?.rows ?? 24 },
      {
        select: key => { void update($, selected, () => key) },
        handoff: () => { void handoffSelected($) },
        save: () => { void saveSelected($) },
        close: () => { void closeSelected($) },
        copy: press => { void copyResume($, press.surface) },
        refresh: () => { void scan($, true) },
      },
    )
  })
}
