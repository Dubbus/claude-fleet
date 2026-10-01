# claude-fleet

A [Claude Code](https://claude.com/claude-code) mod that shows every Claude session running on your
machine: what each one is working on, the state of its code, and how much context it holds.

```
9 sessions · 2 busy · 3 idle > 7d · 1.4M tokens to re-cache · 3 safe to close

▸ ● Auth middleware refactor        busy   api   feat/auth ✎4 ↑2   now        182k
  ● Flaky checkout test triage      idle   web   main ✎30 ↑13       6d   161k cold
  ◐ Postgres migration dry run      idle   api   master ✎3 ↑2      12d   338k cold
  ○ Regex for ISO dates             idle   web   main               2d    14k cold
```

If you keep several sessions open, or run parallel agents in worktrees, it's easy to lose track of
which ones are working, which are waiting on you, and which have been sitting on uncommitted work
for weeks.

## What you get

- **Status line**, always on: `⧉ 9 sessions · 2 busy · 1 need you`.
- **`/fleet`** opens a live pane, refreshed every 5s. For each session it shows:
  - a short **title** for what the session is about, instead of names like `projects-3f`
  - its status: busy in yellow, waiting on you in red
  - project folder and git branch
  - uncommitted files (✎) and commits ahead of or behind upstream (↑↓)
  - time since it was last active
  - its **context size**

  Worktrees of the current repo with no session in them show up too. A conversation resumed in two
  terminals is marked `×2`; closing the older window loses nothing.
- **Keyboard controls in the pane:**
  - **↑/↓** selects a session.
  - **h** writes a handoff. Once it's written, the row offers **x** to close that session with one
    press (for 20s), since its context now lives in the handoff.
  - **s** saves the full conversation as Markdown.
  - **x** closes it (press twice to confirm).
  - **c** copies its `claude --resume` command.
  - **r** refreshes.
- **Context size and "cold":** the right column is how many tokens the session's next message
  sends. Once the prompt cache has expired (marked `cold`), that whole context gets cached again at
  full price. A 2M-token session you only half need is often cheaper to save and close than to resume.
- **Resume value**, so you know whether a session is worth re-caching:
  - **●** *in progress*: work stopped mid-flight. Worth resuming.
  - **◐** *finished*: real work, but the task was delivered. Write a handoff and close it.
  - **○** *light*: quick questions. Just close it.

  The same Haiku call that writes the title makes this judgment, so it costs nothing extra.
- **`/fleet handoff [pid|name]`** (or **h** in the pane) writes `claude-handoff-<title>-<date>.txt` in the
  session's folder. It's a short summary: the goal, status, decisions and why, next steps, key files,
  and gotchas. A fresh session can continue from about 3k tokens instead of re-caching the whole
  conversation, and the original session stays resumable.
- **`/fleet save [pid|name]`** exports a conversation to `claude-context-<title>-<date>.md` in that
  session's folder: your messages, Claude's replies, and a one-line note for each tool call. With no
  argument it saves the current session. It warns you if the file isn't git-ignored, since
  conversations can contain secrets.
- **`/fleet kill [--handoff|--save]`** closes sessions that are safe to close: cold and finished or
  light, or idle for over a week and not in progress. **`/fleet kill all [--handoff|--save]`** closes
  every idle session except yours.
  - The first run only lists what would close. Repeat the command within 60s to confirm.
  - Busy sessions and sessions waiting on you are never closed.
  - Each process ID is re-checked to confirm it's still a Claude process before it's signalled.
  - With `--handoff` or `--save`, a session whose export fails is left running.
  - Conversations stay on disk, so `claude --resume` brings any of them back.
- **`/fleet list`**, **`/fleet stale`**, **`/fleet retitle`** and **`/fleet help`** print the same information as text.
  These also work in `claude -p`.

## Install

```sh
git clone https://github.com/Dubbus/claude-fleet
claude --plugin-dir claude-fleet
```

Or set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/claude-fleet` to load it in every session.

Built against Claude Code 2.1.286. The mod API is early access and may change between releases.

## How it works, and what leaves your machine

- **Sessions:** Claude Code keeps one small JSON file per running session in
  `~/.claude/sessions/`. fleet reads only the `pid`, `cwd`, `name`, `nameSource`, `status`,
  `sessionId` and `updatedAt` fields. It never reads the other fields, which include auth tokens.
  It checks each process ID with `ps`.
- **Git:** fleet runs `git status --porcelain=v2 --branch` in each distinct folder, only while the
  pane is open.
- **Context size:** fleet reads the token usage of the last reply from the end of each session's
  transcript. A transcript is only re-read when it has grown.
- **Titles and resume value:** for each session, fleet sends its first few and latest requests, the
  end of its last reply, and how long it has been idle to Claude Haiku, through your own Claude Code
  login. It caches the result and only redoes it when the transcript has doubled in size. Sessions
  you named yourself with `/rename` keep their names.
- **Handoffs:** only when you ask for one, fleet sends the conversation's text (your messages,
  Claude's replies, and one-line tool notes; at most about 100k tokens, with the middle trimmed on
  long sessions) to Claude Sonnet, through your login.

Those two are the only things sent anywhere. Everything else stays local, and there are no
dependencies.

`~/.claude/sessions/` is an internal Claude Code file, not a public API, so a future release may
change it. If that happens, fleet tells you in the pane, the status line and `/fleet list`, rather than
showing an empty list. If the registry has moved, set `CLAUDE_FLEET_REGISTRY` to the new folder.

## License

MIT
