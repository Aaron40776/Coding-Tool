# Changelog

## Unreleased

- Speed: a greeting ("hey", "thanks") is answered by one short tool-less Haiku call instead of classify + a full Claude Code session (about 8 s down to 3 s here, and far more where plugins, hooks or MCP servers slow every `claude` start-up). Classify, plan and review calls also start `claude` lean (no hooks, plugins, MCP servers or skills; `runner.leanCalls`, on by default, with an automatic fallback if that breaks login).
- Routing: the classifier also rates difficulty and answers pure questions itself (one Haiku call in total, no coding session); a `hard` single task goes straight to Opus (steps of a written plan stay on Sonnet). The git snapshot now runs while the classifier and planner work instead of before them.
- Auto effort: each coding step gets a thinking-effort level chosen from the task (low for trivial/small edits, medium for multi-file and large builds, one higher on Opus and on retries; planner high for large builds; none for Haiku). `runner.autoEffort` (default on); an explicit `runner.effort` still wins. Shown next to the model in the plan.
- `SMART_DEBUG=1` writes per-call timing (start-up, first text, total) to `~/.smart/debug.log`.
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
