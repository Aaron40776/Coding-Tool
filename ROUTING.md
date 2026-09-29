# How `smart` routes tasks (and how to tune it)

`smart` never guesses a model name. Every model it uses comes from `smart.config.json`, and every routing
decision is shown in the UI with its reason (for example `multi_file → sonnet` or `keyword "race condition" → opus`).

## The pipeline

1. **Classify** (cheap model, default Haiku). Scores your prompt as one of four complexities and says whether it needs a plan.
2. **Plan** (default Opus), only when the task needs one. A large build always does. `--no-plan` turns this off.
3. **Route** every step to a model.
4. **Execute** each step with a lean prompt, then **verify** it (tests, lint, build).
5. **Escalate** a step that keeps failing to the next model up.

## Complexity → model (defaults)

| Classifier says | Meaning | Default tier |
| --- | --- | --- |
| `trivial` | a question or explanation, no file changes | haiku |
| `small_edit` | a small change in one file | sonnet |
| `multi_file` | a feature or fix across several files | sonnet |
| `large_build` | building an app or big system from scratch | sonnet (planned by opus) |

The planner and classifier have their own roles (`routing.planner`, `routing.classifier`).

## Precedence

For each step, the first rule that applies wins:

1. **Forced model**: `--model <tier>` or `/model <tier>`. It applies to every step and to the planner, and a forced model is never escalated away from.
2. **Your per-step choice** on the plan approval screen (press `m`).
3. **Keyword rules**: `routing.keywordRules`, case-insensitive regexes matched against the step text (or your prompt, when there is no plan). First match wins.
4. **Unusable classifier output**: if the classifier fails or returns malformed JSON, the task runs on **sonnet** and a warning is shown.
5. **The complexity map**: the table above.

## Conversations and follow-ups

`smart` keeps one conversation per run, like Claude Code:

- **Coding steps** run in a persisted Claude Code session (`--session-id`, then `--resume`) shared by all steps and all follow-up tasks,
  so the model sees the real history, its own earlier tool calls, and the files it read.
- **Classifier and planner** are stateless (no tools, no transcript). They get a compact memory instead: for each earlier task, the request,
  outcome, plan summary, files changed, and your last reply. That is what lets "make it red" be classified and planned correctly.
- `smart -c` continues the last conversation for the current directory (stored in `~/.smart/conversations.json`); `/new` forgets it.
- If Claude Code no longer has the saved session, `smart` starts a new one and puts the memory summary in the prompt.
- `session.resume: false` turns the persisted session off: every step is stateless and gets the memory summary in its prompt instead.

**Model switches and the prompt cache.** Anthropic's prompt cache is per model. Resuming a long session on a *different* model re-reads the whole
history at full price (I measured $0.18 vs $0.025 for the same follow-up). So for follow-up tasks, while the session is warm
(`session.cacheTtlSec`, default 300), automatic routing will not downgrade to a model that has no warm cache in this conversation; the reason
shown says `kept sonnet`. Upgrades, `--model`, your per-step choice on the approval screen and keyword rules always apply, and steps within one plan are always routed on their own merits.
Set `session.keepWarmTier: false` to disable.

## Review: a quality gate that works without tests

Automated checks (below) only exist when the project has them. So after every plan step, `smart` also asks a cheap reviewer model (`routing.reviewer`,
default `haiku`) whether the step's **acceptance criteria** are met by the files it changed. Single-step tasks are reviewed only when no check ran.
The reviewer is told to fail only for concrete, verifiable problems (unmet criterion, syntax error, missing function), never for style. A "fail" feeds
the same retry-then-escalate loop as a failing test. It costs a few cents per step; set `review.enabled: false` to skip it, or `routing.reviewer: "sonnet"` for a stricter one.

## Usage limits

Claude reports your account's 5-hour and 7-day usage on every call. When any window reaches `usage.downshiftAt` (default 0.9), *automatic* routing and
planning use Sonnet instead of Opus, with the reason shown (`5h limit at 93% so using sonnet instead of opus`). Forced models, your per-step choice, and
escalations after a failing step are never downshifted. Warnings appear once per window at `usage.warnAt` (default 0.8) and at 95%.

## Escalation

After a step runs, `smart` runs your checks. If they fail:

1. retry on the **same model** (`escalation.retriesPerModel`, default 1), with the failing output added to the prompt;
2. then move **one tier up** `escalation.ladder` (`haiku → sonnet → opus`) and repeat;
3. if the top model also fails, the step fails and later steps are not run.

Checks are auto-detected from `package.json` scripts, in cheapest-first order: `typecheck`, `lint`, `build`, `test`
(npm's placeholder test script is ignored). Override them with `verify.commands`, for example `["pytest -q", "ruff check ."]`.
A question that changed no files is not verified.

## Tuning

Copy `smart.config.example.json` to `./smart.config.json` (or `~/.smart/smart.config.json`). Only the keys you set are changed.

**Spend less**
- Send more work to a cheaper model: `"routing": { "multi_file": "haiku" }`.
- Escalation is your safety net, so an aggressive downgrade costs little when checks exist. Without checks there is no signal to escalate on, so keep Sonnet.
- Lower `limits.maxPlanSteps`. Every step is a separate Claude Code call, and each call carries Claude Code's own base context.
- Set `limits.maxBudgetUsdPerStep` to cap a runaway step.

**Cap spending**: `limits.maxBudgetUsdPerTask` stops a task once its total cost reaches that many dollars; `limits.maxBudgetUsdPerStep` caps one step.

**Effort per model**: `"runner": { "effort": { "haiku": "low", "opus": "high" } }` passes `--effort` for that tier (levels: low, medium, high, xhigh, max). Unset uses Claude Code's default.

**Get better results**
- `"routing": { "large_build": "opus" }` or `"multi_file": "opus"` for harder work.
- Add keyword rules for the areas where you want the strongest model:
  `{ "match": "auth|payment|migration|concurren", "tier": "opus" }`.
- Raise `escalation.retriesPerModel`, or set it to `0` to escalate immediately.

**Use different models**: change `models`. Values are passed to `claude --model`, so aliases (`sonnet`) and full model IDs both work.

## Permissions

`runner.permissionMode` defaults to `bypassPermissions`, so steps can run commands such as `npm install`. Claude Code refuses that mode when run as root
(common in Docker and CI), so `smart` falls back to `acceptEdits` and tells you. Use `"acceptEdits"` if you do not want commands to run unprompted.
