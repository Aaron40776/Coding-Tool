# Changelog

## 0.3.0 (2026-09-30)

- **Install and update in one command**: `irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 | iex` checks Git, Node.js 22+ and Claude Code, then clones, builds and links smart; `smart update` pulls, installs and rebuilds. CI parses the installer with Windows PowerShell 5.1 and runs it.
- **Progress on the taskbar**: in Windows Terminal the tab and taskbar button show how far a task is, turn yellow while a plan waits for your approval and red when a task failed.
- Fix (Windows): a folder spelled with different capitals (`C:\Users\Me\app` vs `c:\users\me\app`) no longer loses its conversation, `/resume` task and `/undo` history. Entries saved under another spelling are still found.

- **Windows 10/11 only**: CI runs on Windows (Node 22 and 24) and the docs are written for PowerShell. The README's install commands no longer use `&&`, which Windows PowerShell 5.1 (the default on Windows 10/11) rejects.

- **Cheaper long conversations**: once the Claude Code session has grown past `session.maxContextTokens` (default 80k tokens), the next task starts a fresh session with the conversation summary. Every turn of every step re-reads the whole session, so long chats used to make each step dearer. The size is measured from Claude's own usage report.
- **Faster plans**: steps before the last run the quick checks (typecheck, lint, build); the test suite runs after the last step, where anything an earlier step broke is still caught and fixed. `verify.testEveryStep: true` restores tests after every step; your own `verify.commands` always all run.
- **Config**: your global `~/.smart/smart.config.json` and a project's `smart.config.json` are merged (the project wins key by key). A project file used to hide your global settings completely. `smart init` now writes a small starter with notes instead of every default (which pinned them all, so improvements to the defaults never reached you); `smart init --global` writes your global one. `"//"` keys are allowed as comments.
- `--model <tier> --no-plan` no longer spends a classifier call: nothing it says would change what runs.
- Page Up / Page Down scroll the output while typing, without switching panels.
- Fix (macOS and other symlinked paths): a file Claude reported through a symlinked folder (macOS `/var` is `/private/var`) was listed as `../../…/src/a.ts` instead of `src/a.ts` in the files a step touched. Found by the new macOS CI.
- Node.js 22 or newer is required (Node 20 reached end of life in April 2026); CI runs on Linux, Windows and macOS with Node 22 and 24.

- **Usage limit reached**: Claude refusing a call because your 5-hour or weekly limit is used up now stops the task at once. It used to count as an ordinary failure: a retry, then escalation to a bigger model, each refused again. `smart` says when the limit resets (from Claude's message or the last reported window) and keeps the task for `/resume`, also when it happened in the first step (a task that failed before any step finished could not be resumed).
- **`/undo` is safer and survives restarts**: it reverts only the files the task changed (it used to revert every file that differed, including your own later edits to other files and files you created). The last 20 tasks are remembered per directory, so `/undo` and `/diff` work after quitting and starting `smart` again, and after `/new`.
- **Type while a task runs**: `Enter` queues the next task, which starts when the current one completes (not after a failure; `Esc` cancels both). Read-only commands such as `/usage`, `/cost` and `/diff` work meanwhile. `@file` completion now picks up files created during the session.
- Answers: a question the classifier rated easy keeps its answer instead of being re-asked, and keyword rules (`deadlock` → Opus) no longer apply to questions: "what is a deadlock?" was being re-answered by Opus.
- Checks run with the project's package manager (`packageManager` field, else `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`; npm when that tool is missing).
- Faster: the output panel no longer re-wraps its whole log on every token update, `/stats` reads the history file once instead of on every frame, the history file is written compactly (about 40% smaller) and re-parsed only when it changed, and on Windows the `claude` executable is looked up once instead of on every call.

- Fix (Windows): the file lock that keeps several smart sessions from overwriting each other's history could let two of them run unlocked, because Windows reports "directory is being deleted" as EPERM/EACCES/EBUSY instead of "exists"; that is now retried, as is a briefly busy lock removal. Found by CI on `main` (one of 32 concurrent history entries lost on Windows/Node 22).
- Speed: a lone edit rated easy ("fix the typo in the readme") is no longer sent to the reviewer: in a live run the review call took 11.6 s, longer than the 9.3 s edit, for nothing to check. Plan steps and anything not rated easy are still reviewed.
- **Every phase picks its own model and effort.** Classify: routine one-line edits ("fix the typo in the README") are recognised locally and skip the classifier call (`routing.fastLane`). Answer: an easy question is still answered by the classifier; a question the rater scores 0.25 or more goes to the model and effort it picks in one tool-free call (Sonnet capped at medium effort unless you pin `runner.effort.sonnet`). Plan: the notice now names the planner's model and effort. Review: Haiku normally, Sonnet at low effort for a step rated as hard as Opus work.

- **The rater** replaces the fixed "complexity → model" table. Every task and every plan step gets a 0..1 difficulty score from three opinions (local signals in the text, the classifier's complexity and difficulty, and the planner's own per-step rating) and a confidence, and is placed on a cost ladder: Haiku, Sonnet low/medium/high, Opus medium/high/xhigh. It leans up when the opinions disagree, uses the local signals alone if the classifier fails, and learns from your own history which rungs passed first time (one rung up after repeated failures, one effort level down after a long clean run). `routing.optimize` (`cost`/`balanced`/`quality`) shifts the boundaries, the per-complexity tiers are now floors, and `smart --rate "task"` shows the rating and reasons without calling a model. The routing reason now leads with the verdict.
- Correction: Opus is about 2x Sonnet per token (measured), not 5x as an earlier note here said.
- Cheaper planning: mid-size multi-part tasks are now planned by Sonnet (`routing.plannerLight`, about 2x cheaper and somewhat faster in a live comparison: $0.016 vs $0.033 for the same plan), Opus only plans big builds and `hard` tasks. Plans are steered towards fewer, larger steps (`limits.maxPlanSteps` default 8 to 6). A change that only touches prose or images skips the project checks.
- Docs can no longer drift from the code: tests compare `smart.config.example.json` (and so `smart init`), the README, ROUTING.md, CONTRIBUTING.md, `/help` and the command-line flags with the real settings, commands and files. The example config was missing `routing.reviewer`, `review` and the three file paths; the README was missing `--config`, `--continue`, `--print`, `--verbose` and `--no-review`.

- Tidy: README cut from 183 to about 80 lines (details live in ROUTING.md, which now also covers effort, faster start-up and undo); `PLAN.md` (the original build plan, long out of date) removed; file-backed stores grouped in `src/core/store/` with one shared atomic-write helper instead of four copies; `/config` also shows effort and lean-call settings.
- Speed: a greeting ("hey", "thanks") is answered by one short tool-less Haiku call instead of classify + a full Claude Code session (about 8 s down to 3 s here, and far more where plugins, hooks or MCP servers slow every `claude` start-up). Classify, plan and review calls also start `claude` lean (no hooks, plugins, MCP servers or skills; `runner.leanCalls`, on by default, with an automatic fallback if that breaks login).
- Routing: the classifier also rates difficulty and answers pure questions itself (one Haiku call in total, no coding session); a `hard` single task goes straight to Opus (steps of a written plan stay on Sonnet). The git snapshot now runs while the classifier and planner work instead of before them.
- Auto effort: each coding step gets a thinking-effort level chosen from the task (low for trivial/small edits, medium for multi-file and large builds, one higher on Opus and on retries; planner high for large builds; none for Haiku). `runner.autoEffort` (default on); an explicit `runner.effort` still wins. Shown next to the model in the plan.
- `SMART_DEBUG=1` writes per-call timing (start-up, first text, total) to `~/.smart/debug.log`.
- Fixes from a full code review:
  - Ending a task (Esc, Ctrl+C, an error, one-shot mode) now saves its state (cost record, `/resume`, `/undo` checkpoint) *before* the frontend is told it is over, and quitting waits up to 3 s for that; a greeting can no longer overwrite an unfinished task; a new task can start from the terminal event without "already running".
  - `/undo` and `/diff` only cover the directory smart runs in (in a monorepo they used to see, and could restore, sibling packages); `/diff` ignores external diff tools.
  - Calls that end in an error (max turns, budget) still count towards totals and the per-task budget.
  - Several smart sessions no longer overwrite each other's history, conversations and prompt history (lock file).
  - Stale account limits (a window that has already reset) no longer force Sonnet; the header shows the real permission mode; replies, help and diffs are shown in full instead of cut at 8 lines; scrolling stops at the first line; long plans scroll in the checklist; `@app/[id]/page.tsx` mentions work; an empty new plan step cancels itself; `-p --output-format json` reports a failed step in `error` and resumed steps as done; startup errors are visible instead of wiped with the alternate screen; file lists skip `node_modules`/`dist` and stop at the limit.
- Removed the estimated-savings comparison from `/stats` and `/cost`, the `pricing` setting (old configs that still have it load without a warning) and the `npm run bench` harness: they compared list prices, not real usage.
- Repo renamed to `Smart`: URLs, badge and clone instructions updated.
- `/resume` and `smart --resume` (also `smart -p --resume`): continue a failed or cancelled task from its first unfinished step, without re-classifying or re-planning. The approved plan and finished steps are saved with the conversation.
- Plan review: add (`a`), delete (`d`) and reorder (`J`/`K`) steps; multi-line instructions (`Alt+Enter` or `\` + `Enter`).
- `SMART_E2E=1` real-CLI smoke test.
- README: install from a clone (the package is not on npm yet).

## 0.2.0

First complete release: a Claude Code wrapper with smart model routing.

- Classify (Haiku) → plan (Opus, only when worthwhile) → route each step to the cheapest capable model (Sonnet by default) → verify → escalate on failure.
- Conversation continuity: one persisted Claude Code session per conversation (`--resume`), `-c` to continue, `/new` to reset, self-healing if the session is gone.
- Usage: `/stats`, `/usage` (5h/7d account windows), `/cost`, live header meter, limit-aware routing, `--budget`.
- Quality and safety: acceptance review, git shadow checkpoints with `/diff` and `/undo`, permission modes (`/mode`), config warnings.
- QOL: `@file` mentions with completion, multi-line input, persistent prompt history, slash-command completion, `smart init`.
- Headless `-p` mode with `--output-format json`, stdin tasks and stable exit codes (0/1/130).
- Layout: no flicker (measured), adapts down to very small terminals; plan review always shows title, list and details.
- Windows: `claude.exe` / npm shim detection, process-tree kill, CI on Ubuntu and Windows (Node 20/22).
