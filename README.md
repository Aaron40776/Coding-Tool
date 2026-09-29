# smart

[![CI](https://github.com/Aaron40776/Coding-Tool/actions/workflows/ci.yml/badge.svg)](https://github.com/Aaron40776/Coding-Tool/actions/workflows/ci.yml)

**Claude Code, routed to the cheapest model that can do each step well.**

`smart` is a full-screen terminal UI that wraps [Claude Code](https://docs.claude.com/claude-code). Type a task such as
*"make me a snake game"*. It classifies the task, expands a vague request into a short plan you can review, picks a model for
each step (Haiku, Sonnet or Opus), runs Claude Code headless, checks the result with your tests, and escalates to a stronger
model only when a step fails. Everything is shown live, with a running cost meter.

## Install

Requires Node.js 20+ and the [Claude Code CLI](https://docs.claude.com/claude-code) on your `PATH`, already logged in (run `claude` once).

**Windows:** works in Windows Terminal / PowerShell. If PowerShell says *running scripts is disabled*, run
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once (or use `npm.cmd`). `smart` finds `claude.exe`, or the npm
`claude.cmd` shim; set `SMART_CLAUDE_BIN` to point at a specific executable if detection fails.

`smart` is not on the npm registry yet, so install it from a clone (this works on Windows, macOS and Linux):

```sh
git clone https://github.com/Aaron40776/Coding-Tool.git
cd Coding-Tool
npm install
npm run build
npm link            # puts `smart` on your PATH; then run: smart
```

To update later: `git pull`, `npm install`, `npm run build`. To remove: `npm unlink -g @aaron40776/smart`.
(Once published, `npm install -g @aaron40776/smart` will work too.)

## Usage

```sh
smart                                # interactive
smart "make me a snake game"         # one-shot: same UI, exits when done (non-zero exit code on failure)
smart --dry-run "add dark mode"      # classify + plan + show the model per step and why; run nothing
smart --model haiku "rename foo to bar in utils.ts"   # force a model tier for every step
smart --no-plan "refactor the parser"                 # skip planning, run as a single step
smart --config ./my.config.json "..."
smart -c                             # continue the previous conversation in this directory (like `claude -c`)
smart --budget 1.50 "big refactor"   # stop the task if it reaches $1.50
smart init                           # write a starter smart.config.json here
```

### Headless / scripts / CI (`-p`)

```sh
smart -p "fix the typo in README"              # reply on stdout, progress on stderr, exit code 0/1 (130 if cancelled)
echo "add a --version flag" | smart -p         # the task can come from stdin
smart -p --dry-run "build a REST API"          # print the plan and the model chosen per step, run nothing
smart -p --output-format json "..." | jq .     # one JSON document: steps, models, outcome, changes, cost, reply
smart -p --verbose "..."                       # also stream tool calls to stderr
```
Plans are auto-approved in `-p` mode. It needs no terminal, so it works in pipes and CI. Add `-c` to continue a conversation, `--model` to force a tier, `--no-review` to skip the review.

### Keys and commands

| | |
| --- | --- |
| `Enter` | send |
| `Esc` | cancel the running step (or close a view) |
| `Tab` | switch panel (input / plan / output); `↑ ↓` select or scroll |
| `/stats` | usage history: today / 7 days / all time, per-model spend, escalations, estimated savings |
| `/usage` | your Claude account limits (5-hour and 7-day windows) with reset countdowns |
| `/cost` | what this session spent, by model |
| `/config` | the effective routing and safety settings |
| `/model <haiku\|sonnet\|opus\|auto>` | force a model |
| `/dry` | toggle dry-run |
| `/new` | start a fresh conversation (forget earlier tasks) |
| `/undo` | revert the file changes of the last task (needs git); repeat to step back further |
| `/diff` | show what the last task changed |
| `/resume` | continue a failed or cancelled task from its first unfinished step (`smart --resume` does it at startup, `smart -p --resume` headless) |
| `/mode <bypass\|edits\|plan\|auto>` | permission mode; `plan` is read-only |
| `/help`, `/quit`, `Ctrl+C` | help, quit |

Type `/` to see command suggestions; `Tab` completes. `↑` recalls earlier prompts (kept across sessions).

**Referencing files:** type `@` and a path (`Tab` completes it): `refactor @src/parser.ts to use async iterators`. The file's contents go to the planner and the first coding step.
**Multi-line prompts:** end a line with `\` and press Enter (or Alt+Enter), or just paste; pasted text never sends by itself.

**Plan approval.** After planning, review the plan: `↑ ↓` select, `Space` skip a step, `a` add a step after the selected one, `d` delete it, `J` / `K` move it down / up,
`m` pick a model for a step, `e` / `i` edit a step's title / instructions (instructions can be multi-line: `Alt+Enter`, or `\` then `Enter`), `PgUp` / `PgDn` scroll a long step,
`Enter` run, `Esc` cancel. Full step text is always reachable, even on a small terminal.

### The screen

- **Pipeline bar:** classify → plan → execute → verify, live.
- **Plan checklist:** ticks off as steps finish, with a model badge and the routing reason for each step.
- **Output:** streamed text and tool calls from Claude Code, verification results, warnings.
- **Meter:** cost and tokens for this task and for the session.

## Usage stats and limits

- **Your account usage, live.** Claude reports how much of your 5-hour and 7-day allowance is used on every call. `smart` shows it in the header
  (`5h 74% · 7d 18%`, colored by pressure and remembered between sessions) and in `/usage`, and warns once when a window passes 80%.
- **Limit-aware routing.** When a window reaches 90% (`usage.downshiftAt`), automatic routing and planning stop choosing Opus (which burns the
  allowance fastest) and use Sonnet instead, and the reason is shown. `--model`, your per-step choices and escalations after a failure are not affected.
  Set `"usage": { "downshiftAt": 0 }` to turn this off.
- **`/stats`** shows spend for today, the last 7 days and all time, cost per model, how often steps escalated, what classify/plan/review cost, your priciest tasks,
  and an **estimated saving** versus running everything on Sonnet or Opus. Real costs are what Claude Code reports; the comparison prices the same tokens at
  list prices from `pricing` in your config, so treat it as an estimate. On tiny tasks the overhead can outweigh the saving, and `/stats` says so.

## Quality and safety

- **Acceptance review.** After each plan step (and after a single-step task when no automated check ran), a cheap model (`routing.reviewer`, default Haiku)
  checks the plan's acceptance criteria against the files the step changed. Concrete problems go back to the coder as a retry, then escalate like a failing test.
  So a project **without tests still gets a quality gate**. It fails open (never blocks on a reviewer outage) and is skipped for questions and no-op steps.
  Turn it off with `"review": { "enabled": false }`.
- **Checkpoints, `/diff`, `/undo`.** In a git repository, smart snapshots the working tree before and after each step using a private temporary index:
  your index, branches and history are never touched (only a few unreferenced objects are added, which `git gc` removes). This finds every changed file
  (including ones made by shell commands), shows a per-task summary (`Changed 3 files (+120 −4)`), and lets you undo a task's changes. Not a git repo? `git init` enables it.
- **Project-aware planning.** The planner also sees your `CLAUDE.md` / `AGENTS.md` and `package.json` (scripts, dependencies), so plans follow your conventions.

## How it saves tokens (and what it does not)

- A cheap model classifies the task, so trivial questions never reach a big model.
- The classifier and planner are stateless, tool-free calls that get only a compact memory of earlier tasks, never the full transcript.
- Coding steps run in one persisted Claude Code session per conversation, resumed with `--resume`, so **follow-ups have the real history**
  ("now make it red" works). Claude Code caches that history and compacts it as it grows.
- While that session's prompt cache is warm, follow-ups are not downgraded to a model whose cache would start cold
  (re-reading the history at full price costs more than it saves). See [ROUTING.md](ROUTING.md#conversations-and-follow-ups).
- Work goes to the cheapest model that passes your checks; failures escalate one tier at a time.
- The planner is instructed to be terse and to add nothing you did not ask for.

What it does not do: shrink Claude Code's own base context (its system prompt and tool definitions, roughly 30k tokens per call in my measurements).
Every step pays that once, mostly as cheap cached reads, which is why plans are kept short. On an API key, `"runner": { "bare": true }` runs
Claude Code in `--bare` mode to skip hooks, plugins and `CLAUDE.md` discovery. Costs shown are what Claude Code reports, not estimates.

## Configuration

`./smart.config.json`, then `~/.smart/smart.config.json`, then built-in defaults. Only set what you want to change.
See [`smart.config.example.json`](smart.config.example.json) and **[ROUTING.md](ROUTING.md)** for what every rule does and how to tune it.

History is written to `~/.smart/history.json` (`trackerPath`). Unknown keys in a config file and risky project-local settings
(`verify.commands`, `runner.extraArgs` in a `smart.config.json` that came with a repo) produce a warning at startup, so a cloned repo cannot silently run commands.
Stores (history, conversations, prompt history, limits) are written atomically with owner-only permissions; a corrupt file is moved aside, never lost.

## Safety

By default steps run with `bypassPermissions` so they can install packages and run commands; `smart` says so on startup. Use
`"runner": { "permissionMode": "acceptEdits" }` if you prefer Claude Code to deny anything beyond file edits. Run it in a directory you trust,
ideally a git repo so you can review the diff. Claude Code refuses `bypassPermissions` as root, so `smart` falls back to `acceptEdits` there.

## Errors

- `claude` not found, or not logged in: `smart` says so and how to fix it.
- Malformed classifier output: falls back to Sonnet with a warning. Planner failure: runs the task as a single step.
- A cancelled step is reported as cancelled, not failed.

## Architecture

The core (`src/core`) has no UI imports (enforced by ESLint) and emits typed events (`step:start`, `tokens`, `step:done`, `step:failed`, ...),
so a web or desktop UI can reuse it. The Ink UI (`src/ui`) only subscribes.

```
classifier → planner → router → runner → verifier → tracker      (orchestrated by pipeline.ts)
src/core/claude.ts is the only place that spawns `claude`
```

## Development

```sh
npm install
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source
```

Tests mock Claude (`vitest`, `ink-testing-library`). Run the CLI wrapper against the real `claude` with `npm run dev`.

## License

MIT
