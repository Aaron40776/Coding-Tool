# Changelog

## Unreleased

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
