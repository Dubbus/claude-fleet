// CLAUDE_FLEET_DEMO=1: a fixed, made-up fleet for screenshots and trying the pane safely.
// Demo rows have no transcripts and their pids aren't Claude processes, so no action can touch anything.
import type { Git, ResumeValue, Row } from '../../types'

import { DEMO_PREFIX } from './constants.ts'

export const demoRows = (now: number): Row[] => {
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
    row(8, 'GraphQL schema review', 'idle', 'api', 30 * d, 212_000, 'reference', git('main')),
    row(9, 'GraphQL schema review', 'idle', 'api', 31 * d, 212_000, 'reference', git('main'), { sessionId: `${DEMO_PREFIX}8` }),
    {
      key: 'wt:/home/dev/api-hotfix', name: '(no session)', isNamed: true, title: null, value: null, status: 'worktree',
      cwd: '/home/dev/api-hotfix', pid: null, sessionId: '', updatedAt: 0, isSelf: false, git: git('hotfix/rate-limit'), tokens: null,
    },
  ]
}
