# Smart

[![CI](https://github.com/Aaron40776/Smart/actions/workflows/ci.yml/badge.svg)](https://github.com/Aaron40776/Smart/actions/workflows/ci.yml)

**Claude Code, routed to the cheapest model that can do each step well.**

Type a task. `smart` classifies it with Haiku, answers simple questions on the spot, plans big builds with Opus, runs each step on the cheapest capable model (Sonnet by default),
checks the result with your tests and a quick review, and escalates to a stronger model only when a step fails. It is a full-screen terminal UI around [Claude Code](https://docs.claude.com/claude-code),
with the same follow-up context, and shows what everything costs.

## Install

Needs Node.js 20+ and the [Claude Code CLI](https://docs.claude.com/claude-code) on your `PATH`, logged in (run `claude` once).

```sh
git clone https://github.com/Aaron40776/Smart.git
cd Smart
npm install && npm run build
npm link            # puts `smart` on your PATH
```

Update with `git pull && npm install && npm run build`. On Windows PowerShell, if scripts are blocked run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once.
If `claude` is not found, set `SMART_CLAUDE_BIN` to its full path.

## Use

```sh
smart                              # interactive
smart "make me a snake game"       # one-shot: same UI, exits when done
smart -c                           # continue the last conversation in this directory (--continue)
smart --resume                     # continue a failed or cancelled task from its first unfinished step
smart --dry-run "add dark mode"    # show the plan and the model per step, run nothing
smart --model haiku "fix the typo" # force a tier      (--no-plan skips planning, --budget 1.50 caps the cost)
smart -p "fix the typo" | cat      # headless (--print): reply on stdout, progress on stderr (--output-format json for scripts, --verbose for tool calls)
smart --rate "fix the race in worker.js"  # show which model and effort it would pick, and why (calls no model)
smart --no-review "..."            # skip the acceptance review     (--config ./my.json uses another config file)
smart init                         # write a starter smart.config.json
```

In the app: `Enter` sends, `Esc` cancels, `Tab` switches panel, `@path` adds a file (Tab completes), `\`+`Enter` starts a new line, `↑` recalls earlier prompts.

| Command | |
| --- | --- |
| `/stats` `/usage` `/cost` | spend history, your 5-hour / 7-day account limits, this session's cost |
| `/model haiku\|sonnet\|opus\|auto` | force a model; `/dry` toggles dry-run |
| `/undo` `/diff` `/resume` | revert or show the last task's file changes (needs git), continue an unfinished task |
| `/mode bypass\|edits\|plan\|auto` | permission mode (`plan` is read-only) |
| `/new` `/config` `/help` `/quit` | fresh conversation, effective settings, help, exit |

**Plan review** (big builds): `↑↓` select, `Space` skip, `a` add, `d` delete, `J`/`K` move, `m` model, `e`/`i` edit title/instructions, `Enter` run, `Esc` cancel.

## How it saves usage

- A cheap model classifies every task (skipped for routine edits like "fix the typo"); an **easy question is answered by that same call**, a hard one by the model it needs, and "hey" costs one tiny call.
- **Opus plans, Sonnet builds**: big builds get a short plan from Opus (mid-size ones from Sonnet), then each step runs on the cheapest model and effort its rating allows. A hard step goes to Opus. Docs-only changes skip the test run.
- **Model and effort come from a rating**, not a fixed table: local signals in your text, the classifier's opinion and, per plan step, the planner's, blended into a score with a confidence. Routine work runs on Sonnet at low effort, hard work on Opus at medium to xhigh. It also learns which rungs worked for you. `smart --rate "your task"` shows the rating and why, for free.
- Failures **escalate one model at a time**; nothing jumps to Opus by default. Near an account limit, automatic Opus choices drop to Sonnet.
- Follow-ups reuse one Claude Code session, so "now make it red" has the real history (and Anthropic's prompt cache).

Costs shown are what Claude Code reports. Routing rules and every setting: **[ROUTING.md](ROUTING.md)** and [`smart.config.example.json`](smart.config.example.json).

## Safety

Steps run with `bypassPermissions` by default so they can install packages and run commands (`smart` says so at startup; Claude Code refuses it as root and `smart` falls back to `acceptEdits`).
Set `"runner": { "permissionMode": "acceptEdits" }` to be stricter. Run it in a directory you trust, ideally a git repo: `/undo` needs one.
A `smart.config.json` that comes with a repo can run commands (`verify.commands`), so `smart` warns when a project config sets them.

## Development

```sh
npm install
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source
```

Layout and rules: [CONTRIBUTING.md](CONTRIBUTING.md). History: [CHANGELOG.md](CHANGELOG.md). `SMART_DEBUG=1` logs per-call timings to `~/.smart/debug.log`; `SMART_E2E=1 npm test -- test/e2e` runs one real Haiku task.

## License

MIT
