# smart: implementation plan (approved 2026-09-29)

`smart` is an Ink TUI that wraps Claude Code headless. It classifies a task, plans it when it's vague or large,
routes each step to the cheapest capable model, verifies it, and escalates on failure.

## Decisions
- npm package: `@aaron40776/smart`, bin `smart` (both `smart` and `smart-cli` are taken on npm).
- Runner permission mode defaults to `bypassPermissions` (most capable). Configurable via `runner.permissionMode`.
  The UI shows a one-line notice at startup when it is active.
- Workflow: plan on Opus. Implement on Sonnet (the user switches models). Escalate to Opus only if a step fails
  twice or a design problem persists.

## Verified CLI facts (Claude Code 2.1.284)
- Headless: `claude -p --model <alias|id> --output-format stream-json --verbose`.
- Also available: `--json-schema`, `--system-prompt`, `--tools ""`, `--no-session-persistence`,
  `--permission-mode`, `--max-budget-usd`, `--fallback-model`, `--effort`.
- stream-json lines have `type`: `system`(init/status/...), `stream_event`, `assistant`, `user`, `rate_limit_event`, `result`.
- The `result` event has `total_cost_usd`, `usage`, `modelUsage{model:{inputTokens,outputTokens,...}}`,
  `is_error`, `subtype`, `result`, `num_turns`. The tracker uses reported cost, not a price table.
- The default system prompt costs about 4k input tokens per call. Classifier and planner use
  `--system-prompt` + `--tools ""` + `--json-schema`.
- `--bare` needs `ANTHROPIC_API_KEY` (no OAuth). It is opt-in via `runner.bare`.

## Layout
```
src/core/  events config claude(spawn + stream parser; the only place that spawns) classifier planner
           router runner verifier tracker pipeline errors      # no UI imports (ESLint-enforced)
src/ui/    App.tsx, components/{InputBox,PipelineBar,PlanChecklist,StepBadge,CostMeter,OutputLog,
           PlanApproval,StatsView}, hooks/useSmartEvents.ts
src/cli.tsx  commander args → render(<App/>)
test/core, test/ui, test/fixtures/*.jsonl
```

## Interfaces
```ts
type Complexity = 'trivial'|'small_edit'|'multi_file'|'large_build';
interface Classification { complexity; needsPlan: boolean; reason: string; fallback?: boolean }
interface PlanStep { id; title; instructions; files: string[]; acceptance: string[]; skipped?; tier? }
interface Plan { summary; features: string[]; fileStructure: string[]; steps: PlanStep[] }
type ModelTier = 'haiku'|'sonnet'|'opus';
interface RouteDecision { tier; model /* from config */; reason }
interface Usage { inputTokens; outputTokens; cacheRead; costUsd }
runClaude({prompt, model, systemPrompt?, jsonSchema?, tools?, cwd, signal, onEvent}): Promise<ClaudeResult>
```
`Pipeline(config, bus, deps)` takes its deps (runClaude, exec, fs) injected, so they can be mocked.

## Events (core → UI)
task:start, stage{classify|plan|approve|execute|verify|done}, classified, plan:ready (pauses), plan:approved,
step:start{route,attempt}, step:output, tokens{usage,sessionTotal}, step:verify, step:escalate,
step:done, step:failed, task:done, task:cancelled, error{kind,message,hint}.
Commands (UI → core): approvePlan, cancelStep, cancelTask, forceModel, setDryRun.

## Modules
- **classifier**: Haiku with a tiny system prompt, no tools, JSON schema, zod-validated. On any failure it returns
  `multi_file` (which routes to Sonnet) with `fallback: true`.
- **planner**: Opus with no tools and a JSON schema. At most `maxPlanSteps` (8) steps. Runs when `needsPlan` is set
  or the task is `large_build`, unless `--no-plan` is passed. With no plan, the task becomes a single step.
- **router**: a pure function. Order: override, then keyword rules, then the complexity map, then tier → model
  name. The ladder is haiku → sonnet → opus.
- **runner**: one headless call per step. The prompt holds the summary, the step, its acceptance criteria, the files
  touched so far, and the contents of `step.files` (capped by `maxContextBytes`). No history. Esc aborts
  (SIGTERM, then SIGKILL).
- **verifier**: auto-detects the test/lint/build/typecheck scripts, or uses config commands. On failure it retries
  once on the same model with the trimmed error, then moves up one model, then fails.
- **tracker**: appends to `~/.smart/history.json`. `/stats` shows totals per model.
- **errors**: `claude` missing from PATH gives an install hint. Auth errors give "run `claude` to log in".
  A cancel is not a failure.

## UI
Header pipeline bar + cost meter. Left: plan checklist with a model badge and routing reason per step. Right:
output log. Bottom: input box + hints. Plan approval: ↑↓ select, Space skip, e edit, m model, Enter approve,
Esc abort. Keys: Enter, Esc, Tab, `/stats`, `/model <tier|auto>`, `/dry`. One-shot: `smart "<task>"
[--dry-run] [--model x] [--no-plan]`, same UI, exits with a non-zero code on failure.

## Config (`./smart.config.json`, then `~/.smart/smart.config.json`, then defaults)
```json
{ "models": { "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" },
  "routing": { "trivial": "haiku", "small_edit": "sonnet", "multi_file": "sonnet", "large_build": "sonnet",
               "planner": "opus", "classifier": "haiku",
               "keywordRules": [{ "match": "architecture|race condition", "tier": "opus" }] },
  "escalation": { "retriesPerModel": 1, "ladder": ["haiku", "sonnet", "opus"] },
  "limits": { "maxPlanSteps": 8, "maxContextBytes": 40000, "maxBudgetUsdPerStep": null },
  "runner": { "permissionMode": "bypassPermissions", "bare": false, "extraArgs": [] },
  "verify": { "auto": true, "commands": [] },
  "trackerPath": "~/.smart/history.json" }
```

## Tests (Vitest)
- Core: classifier parsing and fallback, router rules and ladder, the stream parser against recorded fixtures,
  verifier retry and escalation, tracker, and the pipeline end to end with a mocked runClaude (including cancel
  and dry-run).
- UI (ink-testing-library): PlanChecklist, StepBadge, CostMeter, PlanApproval, App dry-run.
- Opt-in real-CLI smoke test with `SMART_E2E=1`. CI workflow: lint, typecheck, test, build.

## Build/packaging
ESM, TS strict, tsup → `dist/cli.js` with a shebang, Node ≥ 18. Deps: ink, react, commander, zod, execa.
README, ROUTING.md, LICENSE (MIT), .gitignore.

## Build order (test + build after each)
1 scaffold+config · 2 events+claude parser · 3 router · 4 classifier · 5 planner · 6 tracker · 7 verifier ·
8 runner · 9 pipeline · 10 UI components · 11 App+cli · 12 docs+packaging
