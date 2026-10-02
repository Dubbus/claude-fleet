// What fleet asks Claude: a title and resume value per session (Haiku), and handoffs (Sonnet).
import type { ResumeValue, Row } from '../../types'

import { HANDOFF_HEAD_CHARS, HANDOFF_INPUT_CHARS } from './constants.ts'
import { basename, label } from './format.ts'

export const LABEL_SYSTEM =
  'You label coding sessions for a session list. Reply with JSON only: {"title": string, "value": string}.\n' +
  'title: 3-6 words naming the task, leading with the concrete project and goal ("Canvas lab 2 grading drafts"); ' +
  'no quotes, no trailing punctuation, never the words "session", "conversation" or "chat".\n' +
  'value: whether resuming is worth re-sending the whole conversation. Pick exactly one:\n' +
  '- "light": quick questions or one-off lookups; nothing a fresh session couldn\'t redo in a minute.\n' +
  '- "reference": substantial work whose main task was delivered or answered. This is the DEFAULT for real work. ' +
  'A last reply that offers more help, lists optional next steps, or asks "want me to...?" is still "reference".\n' +
  '- "active": ONLY when work is clearly mid-flight: the last reply stops partway through an implementation, ' +
  'a bug or failing test is still being chased, or the person must answer a question before anything can continue. ' +
  'Sessions idle for weeks are rarely active.'

export const labelPrompt = (first: string[], latest: string[], lastReply: string, idleText: string) =>
  (
    `Opening requests:\n${first.join('\n---\n')}\n\nLatest requests:\n${latest.join('\n---\n') || '(same)'}` +
    `\n\nLast reply (end):\n${lastReply || '(none)'}\n\nIdle for: ${idleText}`
  ).slice(0, 5000)

const cleanTitle = (text: string) =>
  text.split('\n')[0].replace(/^(title:\s*)/i, '').replace(/["'`*#]/g, '').replace(/[.\s]+$/, '').trim().slice(0, 48)

// The label reply as JSON, or a bare title when the model skipped the JSON.
export const parseLabel = (text: string): { title: string; value?: ResumeValue } | null => {
  try {
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const title = cleanTitle(String(raw.title ?? ''))
    const value = ['active', 'reference', 'light'].includes(raw.value) ? (raw.value as ResumeValue) : undefined
    return title ? { title, value } : null
  } catch {
    const title = cleanTitle(text)
    return title && !title.includes('{') ? { title } : null
  }
}

export const HANDOFF_SYSTEM = `You write handoff notes so a fresh Claude Code session can continue someone's work without the old transcript.
From the transcript only, write Markdown with these sections, skipping any that would be empty:
## Goal: what the person is trying to get done, in 1-3 sentences.
## Status: what is done, and what was in progress when the transcript ends.
## Decisions: choices made and WHY, including approaches tried and rejected.
## Next steps: concrete open threads, in order.
## Key files and commands: paths, commands and URLs that matter, as a short list.
## Gotchas: preferences the person stated, constraints, and things that broke.
Be specific and factual: names, paths and numbers over generalities. Never invent. At most 700 words.`

// Keeps the start (where the goal is stated) and as much of the end as fits.
export const trimForHandoff = (text: string) =>
  text.length <= HANDOFF_INPUT_CHARS
    ? text
    : text.slice(0, HANDOFF_HEAD_CHARS) +
      '\n\n[… middle of the conversation omitted …]\n\n' +
      text.slice(-(HANDOFF_INPUT_CHARS - HANDOFF_HEAD_CHARS))

export const handoffDoc = (row: Row, target: string, now: Date, summary: string) =>
  [
    `# Handoff: ${label(row)}`,
    '',
    `Written ${now.toISOString().slice(0, 16).replace('T', ' ')} from session \`${row.sessionId}\` in \`${row.cwd}\`.`,
    '',
    `To continue in a fresh session: run \`claude\` in this folder and say "Read ${basename(target)} and pick up where it leaves off."`,
    `The full conversation is still there: \`claude --resume ${row.sessionId}\`.`,
    '',
    summary.trim(),
    '',
  ].join('\n')

export const continuePrompt = (path: string) =>
  `Read ${path} and pick up where it leaves off. It's a handoff from my previous session in this folder.`
