export type Git = { branch: string; dirty: number; ahead: number; behind: number; hasUpstream: boolean }

// Whether a session is worth re-caching: unfinished work (active), finished but substantial
// (reference: save a handoff and close), or quick questions (light: close).
export type ResumeValue = 'active' | 'reference' | 'light'

export type Row = {
  key: string
  // Claude Code's name for the session; `isNamed` when the person chose it (then it beats `title`).
  name: string
  isNamed: boolean
  // A short topic written by Haiku from the conversation, once fleet has made one.
  title: string | null
  value: ResumeValue | null
  status: string
  cwd: string
  pid: number | null
  sessionId: string
  updatedAt: number
  isSelf: boolean
  git: Git | null
  // Context size of the session's last reply: what resuming it re-caches once the cache is cold.
  tokens: number | null
}

export type Snapshot = {
  rows: Row[]
  scannedAt: number
  // Why the list may be wrong or empty (the registry moved or changed format), else null.
  warning: string | null
}

// What the band above the prompt is offering, for this session only.
export type Band =
  | { kind: 'context'; tokens: number }
  | { kind: 'exit'; tokens: number; value: ResumeValue | null }
  | { kind: 'handedOff'; path: string; then: 'fresh' | 'exit' | null }
  | { kind: 'working'; text: string }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      snapshot: Snapshot | null
      isOpen: boolean
      // The row the pane's actions apply to, by Row.key.
      selected: string | null
      // A row whose close was asked once and waits for the second press.
      pendingClose: string | null
      band: Band | null
    }
  }
}
