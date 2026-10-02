export const TICK_MS = 5000
// The status line only needs the registry; git and token reads run only while the pane is open.
export const STATUS_EVERY_TICKS = 3
export const STALE_MS = 7 * 24 * 60 * 60 * 1000
// Prompt-cache lifetime: 5 minutes on the API by default, 1 hour on some plans.
// Past it, resuming a session pays to cache its whole context again.
export const CACHE_TTL_MS = 60 * 60 * 1000
// How long a `/fleet kill` stays armed for its confirming second run.
export const ARM_MS = 60 * 1000
// Context size comes from the last reply, so the tail of the transcript is enough.
export const TAIL_BYTES = 1_000_000
export const EXPORT_MAX_BYTES = 80 * 1024 * 1024
// Session titles: the opening prompts come from the head, the latest from the tail.
export const HEAD_BYTES = 300_000
export const TITLES_KEY = 'titles'
export const TITLES_PER_SCAN = 2
// Handoffs summarize at most this much of a transcript (head kept for the goal, the rest from the end).
export const HANDOFF_INPUT_CHARS = 400_000
export const HANDOFF_HEAD_CHARS = 60_000
// The band offers a handoff once this session's context passes this (CLAUDE_FLEET_HANDOFF_AT overrides),
// and again each time it grows by HANDOFF_SNOOZE_TOKENS after "Later".
export const HANDOFF_AT_TOKENS = 300_000
export const HANDOFF_SNOOZE_TOKENS = 100_000
// /exit pauses to offer a handoff when the session is in progress or at least this big.
export const EXIT_CHECK_TOKENS = 100_000
export const EXIT_CONFIRM_MS = 30_000
// A second press of x within this window closes the selected session.
export const CLOSE_CONFIRM_MS = 10_000
// After a handoff, one press of x within this window closes that session.
export const AFTER_HANDOFF_MS = 20_000
// A transcript that couldn't be found is looked for again after this long.
export const MISSING_RETRY_MS = 60_000

// Claude Code writes one <pid>.json per running session here. It is an internal
// file, not an API: read only the fields parseRegistryEntry names, never the rest (it holds tokens).
export const REGISTRY_DIR = '.claude/sessions'
export const PROJECTS_DIR = '.claude/projects'

// Demo sessions' ids start with this; no action touches them.
export const DEMO_PREFIX = 'demo-'
