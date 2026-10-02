// Parsers for what fleet reads from disk and from commands: the session registry, git, and transcripts.
import type { Git, Registered, Row } from '../../types'

import { PROJECTS_DIR } from './constants.ts'
import { label } from './format.ts'

// --- Registry ---

// Reads only these fields of a registry file; the others hold tokens and are never touched.
export const parseRegistryEntry = (text: string, mtimeMs: number): Registered | null => {
  const raw = JSON.parse(text)
  if (typeof raw.pid !== 'number' || typeof raw.cwd !== 'string') return null
  return {
    pid: raw.pid,
    name: String(raw.name ?? raw.sessionId ?? raw.pid),
    // 'derived' names are Claude Code's own (folder + suffix); anything else the person set.
    isNamed: typeof raw.nameSource === 'string' && raw.nameSource !== 'derived',
    status: String(raw.status ?? 'unknown'),
    cwd: raw.cwd,
    sessionId: String(raw.sessionId ?? ''),
    updatedAt: Number(raw.updatedAt ?? mtimeMs),
  }
}

export const parsePids = (psOutput: string) =>
  new Set(psOutput.split('\n').map(line => Number(line.trim())).filter(Boolean))

// --- Git ---

// `git status --porcelain=v2 --branch` → branch, uncommitted files, ahead/behind.
export const parseGitStatus = (stdout: string): Git => {
  const git: Git = { branch: '?', dirty: 0, ahead: 0, behind: 0, hasUpstream: false }
  for (const line of stdout.split('\n')) {
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

// `git worktree list --porcelain` → worktree paths.
export const parseWorktrees = (stdout: string) =>
  stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))

// --- Transcripts ---

// Claude Code's project folder name: every character outside [A-Za-z0-9] becomes '-'.
export const transcriptPath = (home: string, row: Pick<Row, 'cwd' | 'sessionId'>) =>
  `${home}/${PROJECTS_DIR}/${row.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${row.sessionId}.jsonl`

// Context size of the last main-thread reply in a transcript tail; what resuming re-sends.
export const lastContextTokens = (tail: string): number | null => {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const u = entry.message?.usage
      if (!u) continue
      return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    } catch {
      // The first line of a tail is usually cut mid-entry.
    }
  }
  return null
}

export const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b?.type === 'text').map(b => String(b.text)).join('\n')
      : ''

// A user turn as the person typed it: reminders dropped, slash commands shown as typed.
export const cleanUserText = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>(.*?)<\/command-name>/g, '$1')
    .replace(/<command-args>(.*?)<\/command-args>/g, ' $1')
    .replace(/<\/?local-command-stdout>/g, '')
    .trim()

export const userPrompts = (jsonl: string) => {
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

export const lastAssistantText = (jsonl: string) => {
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

const toolLine = (block: { name?: string; input?: Record<string, unknown> }) => {
  const input = block.input ?? {}
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
  return `- \`${block.name}\`${detail ? `: ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`
}

// The conversation as Markdown: your messages, Claude's replies, and one line per tool call.
export const toMarkdown = (row: Row, jsonl: string, exportedAt: string) => {
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
