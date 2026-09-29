# smart

[![CI](https://github.com/Aaron40776/Coding-Tool/actions/workflows/ci.yml/badge.svg)](https://github.com/Aaron40776/Coding-Tool/actions/workflows/ci.yml)

**Claude Code, routed to the cheapest model that can do each step well.**

`smart` is a full-screen terminal UI that wraps [Claude Code](https://docs.claude.com/claude-code). Type a task such as
*"make me a snake game"*. It classifies the task, expands a vague request into a short plan you can review, picks a model for
each step (Haiku, Sonnet or Opus), runs Claude Code headless, checks the result with your tests, and escalates to a stronger
model only when a step fails. Everything is shown live, with a running cost meter.

> Screenshot placeholder: add `docs/screenshot.png` and reference it here.

## Install

Requires Node.js 20+ and the [Claude Code CLI](https://docs.claude.com/claude-code) on your `PATH`, already logged in (run `claude` once).

**Windows:** works in Windows Terminal / PowerShell. If PowerShell says *running scripts is disabled*, run
`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once (or use `npm.cmd`). `smart` finds `claude.exe`, or the npm
`claude.cmd` shim; set `SMART_CLAUDE_BIN` to point at a specific executable if detection fails.

```sh
npm install -g @aaron40776/smart     # then run: smart
npx @aaron40776/smart                # or without installing
```

## Usage

```sh
smart                                # interactive
smart "make me a snake game"         # one-shot: same UI, exits when done (non-zero exit code on failure)
smart --dry-run "add dark mode"      # classify + plan + show the model per step and why; run nothing
smart --model haiku "rename foo to bar in utils.ts"   # force a model tier for every step
smart --no-plan "refactor the parser"                 # skip planning, run as a single step
smart --config ./my.config.json "..."
```

### Keys and commands

| | |
| --- | --- |
| `Enter` | send |
| `Esc` | cancel the running step (or close a view) |
| `Tab` | switch panel (input / plan / output); `↑ ↓` select or scroll |
| `/stats` | cost history, per model |
| `/model <haiku\|sonnet\|opus\|auto>` | force a model |
| `/dry` | toggle dry-run |
| `/help`, `/quit`, `Ctrl+C` | help, quit |

**Plan approval.** After planning, review the plan: `↑ ↓` select, `Space` skip a step, `m` pick a model for a step,
`e` / `i` edit a step's title / instructions, `Enter` run, `Esc` cancel.

### The screen

- **Pipeline bar:** classify → plan → execute → verify, live.
- **Plan checklist:** ticks off as steps finish, with a model badge and the routing reason for each step.
- **Output:** streamed text and tool calls from Claude Code, verification results, warnings.
- **Meter:** cost and tokens for this task and for the session.

## How it saves tokens (and what it does not)

- A cheap model classifies the task, so trivial questions never reach a big model.
- Each plan step runs in a **fresh, lean prompt**: the step, its acceptance criteria, the files it names, and the list of files changed earlier.
  There is no growing conversation history.
- Work goes to the cheapest model that passes your checks; failures escalate one tier at a time.
- The planner is instructed to be terse and to add nothing you did not ask for.

What it does not do: shrink Claude Code's own base context (its system prompt and tool definitions, roughly 30k tokens per call in my measurements).
Every step pays that once, mostly as cheap cached reads, which is why plans are kept short. On an API key, `"runner": { "bare": true }` runs
Claude Code in `--bare` mode to skip hooks, plugins and `CLAUDE.md` discovery. Costs shown are what Claude Code reports, not estimates.

## Configuration

`./smart.config.json`, then `~/.smart/smart.config.json`, then built-in defaults. Only set what you want to change.
See [`smart.config.example.json`](smart.config.example.json) and **[ROUTING.md](ROUTING.md)** for what every rule does and how to tune it.

History is written to `~/.smart/history.json` (`trackerPath`).

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
