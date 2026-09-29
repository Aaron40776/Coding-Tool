# Changelog

## 0.2.0

First complete release: a Claude Code wrapper with smart model routing.

- Classify (Haiku) → plan (Opus, only when worthwhile) → route each step to the cheapest capable model (Sonnet by default) → verify → escalate on failure.
- Conversation continuity: one persisted Claude Code session per conversation (`--resume`), `-c` to continue, `/new` to reset, self-healing if the session is gone.
- Usage: `/stats` (with estimated savings), `/usage` (5h/7d account windows), `/cost`, live header meter, limit-aware routing, `--budget`.
- Quality and safety: acceptance review, git shadow checkpoints with `/diff` and `/undo`, permission modes (`/mode`), config warnings.
- QOL: `@file` mentions with completion, multi-line input, persistent prompt history, slash-command completion, `smart init`.
- Headless `-p` mode with `--output-format json`, stdin tasks and stable exit codes (0/1/130).
- Layout: no flicker (measured), adapts down to very small terminals; plan review always shows title, list and details.
- Windows: `claude.exe` / npm shim detection, process-tree kill, CI on Ubuntu and Windows (Node 20/22).
