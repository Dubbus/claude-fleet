# claude-fleet

A [Claude Code](https://claude.com/claude-code) mod that shows every Claude session running on your
machine: what each one is working on, the state of its code, and how much context it holds.

```
10 sessions · 2 busy · 1 need you · 6 safe to close
841k tokens to re-cache · 4 idle > 7d · 1 open in two windows

  ● Payments webhook retry bug    waiting   api     fix/webhooks ✎1         2m        141k
▸ ● Auth middleware refactor      busy      api     feat/auth ✎4 ↑2        now        182k
  ● Flaky checkout test triage    idle      web     main ✎2               25m         96k
  ◐ Release notes for v2.4        idle      docs    main                   3d    44k cold
  ○ Regex for ISO dates           idle      web     main                   2d    14k cold
  ◐ Postgres migration dry run    idle      api     master ↑2             12d   338k cold
  ◐ GraphQL schema review ×2      idle      api     main                  30d   212k cold
```

(The example data above is fleet's demo mode; see [Try it safely](#try-it-safely).)

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
- **Keyboard controls in the pane** to hand off, save, close or resume a session; see
  [Keyboard shortcuts](#keyboard-shortcuts).
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

## While you work

These only work as a mod, since they react to the session you're in:

- **A handoff offer before your context gets expensive.** When this session passes 300k tokens, a band
  above the prompt offers to write a handoff. You can pick:
  - **Hand off and start fresh:** writes the handoff, runs `/clear`, and opens the new conversation with
    "Read <handoff> and pick up where it leaves off".
  - **Just write it.**
  - **Later:** asks again after another 100k tokens.

  Set `CLAUDE_FLEET_HANDOFF_AT` to change the threshold. `/fleet handoff --fresh` does the same thing
  as a command.
- **A pause on `/exit`** when the session is in progress or holds over 100k tokens. You can run
  `/fleet handoff --exit` to hand off and then exit, or run `/exit` again within 30 seconds to quit
  anyway. Set `CLAUDE_FLEET_EXIT_CHECK=0` to turn this off. (It catches `/exit` only, not ctrl+c.)
- **A toast when another session needs you**, for example when it's waiting on a permission prompt,
  and another when a busy session finishes. Set `CLAUDE_FLEET_NOTIFY=0` to turn these off.

To use a band's buttons, give it the keyboard with ctrl+x then Tab, or click it.

## Keyboard shortcuts

`/fleet` opens the pane and gives it the keyboard.

| Key | What it does |
| --- | --- |
| **↑ / ↓** (or Tab) | Select a session. The selected row is highlighted. |
| **h** | Write a handoff for the selected session. Once it's written, the row turns red and one press of **x** closes the session (for 20 seconds). |
| **x** | Close the selected session. The row turns red; press **x** again within 10 seconds to confirm. Your own session and busy ones can't be closed. |
| **s** | Save the full conversation as Markdown in the session's folder. |
| **c** | Copy `cd <folder> && claude --resume <id>` to the clipboard. |
| **r** | Refresh now (it also refreshes on its own every 5 seconds). |
| **Esc** | Give the keyboard back to the prompt. The pane stays open. |
| click the pane | Give the pane the keyboard again. |
| **✕** on the pane | Close the pane. `/fleet` reopens it. |

Every action can also be run as a command: `/fleet handoff`, `/fleet save`, `/fleet kill`; `/fleet help` lists them all.

## Install

Requirements:

- **Claude Code 2.1.286 or later.** Tested on 2.1.286 and 2.1.287. The mod API is early access, so a
  later release may change it.
- **Mods enabled for your account.** Mods are still rolling out; if Claude Code says *"hooks modules
  are turned off … the rollout switch served off"*, your account doesn't have them yet.
- **macOS or Linux.** fleet uses `ps`, `kill`, `head` and `tail`, so it doesn't run on Windows.

```sh
git clone https://github.com/Dubbus/claude-fleet
claude --plugin-dir claude-fleet
```

Or set `CLAUDE_CODE_PLUGIN_DIRS=/path/to/claude-fleet` to load it in every session.

## Try it safely

```sh
CLAUDE_FLEET_DEMO=1 claude --plugin-dir claude-fleet
```

This shows a fixed set of made-up sessions instead of your real ones, so you can try every key without
touching anything: demo sessions have no transcripts and aren't real processes, so save, handoff and
close all do nothing.

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

## Code layout

| File | What's in it |
| --- | --- |
| `hooks/register.tsx` | The hooks, plus everything that touches `$`: reading sessions, git, model calls, saving, closing |
| `hooks/lib/views.tsx` | What the pane and the band draw |
| `hooks/lib/format.ts` | Turning rows into text: the table, summaries, the status line, help |
| `hooks/lib/rules.ts` | What counts as stale, cold, needing you, or safe to close |
| `hooks/lib/parse.ts` | Parsing the registry, git output and transcripts |
| `hooks/lib/prompts.ts` | What fleet asks Haiku and Sonnet, and how replies are read |
| `hooks/lib/constants.ts`, `demo.ts` | Thresholds and timings; demo-mode data |
| `types/index.d.ts` | Shared types and the plugin's state contract |

If you contribute, there's one rule to know: **any function that uses `$` has to live in
`register.tsx`**, because the mod validator only follows `$` within the file that registers the hooks.
Files in `lib/` get plain data and callbacks instead, and the views get the surface's elements.
Run `claude plugin validate .` before sending a change.

## License

MIT
