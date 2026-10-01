export type Git = { branch: string; dirty: number; ahead: number; behind: number; hasUpstream: boolean }

export type Row = {
  key: string
  // Claude Code's name for the session; `isNamed` when the person chose it (then it beats `title`).
  name: string
  isNamed: boolean
  // A short topic written by Haiku from the conversation, once fleet has made one.
  title: string | null
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

export type Snapshot = { rows: Row[]; scannedAt: number }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      snapshot: Snapshot | null
      isOpen: boolean
      // The row the pane's actions apply to, by Row.key.
      selected: string | null
      // A row whose close was asked once and waits for the second press.
      pendingClose: string | null
    }
  }
}
