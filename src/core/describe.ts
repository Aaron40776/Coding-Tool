import type { SmartConfig } from './config.js';
import type { Limits } from './types.js';
import { pct, tightest, windowLabel } from './usage.js';

/** Human-readable effective configuration, for `/config`. */
export function describeConfig(c: SmartConfig, ctx: { permissionMode: string; modeOverridden: boolean; limits: Limits | null }): string[] {
  const r = c.routing;
  const t = tightest(ctx.limits);
  return [
    `Models: haiku=${c.models.haiku}, sonnet=${c.models.sonnet}, opus=${c.models.opus}`,
    `Routing: trivial→${r.trivial}, small_edit→${r.small_edit}, multi_file→${r.multi_file}, large_build→${r.large_build}; classifier ${r.classifier}${r.fastLane ? ' (skipped for routine edits)' : ''}, planner ${r.planner} (big/hard) / ${r.plannerLight} (mid-size), reviewer ${r.reviewer}`,
    r.keywordRules.length ? `Keyword rules: ${r.keywordRules.map((k) => `/${k.match}/→${k.tier}`).join(', ')}` : 'Keyword rules: none',
    `Escalation: retry ${c.escalation.retriesPerModel}× per model, then ${c.escalation.ladder.join(' → ')}`,
    `Effort: ${c.runner.autoEffort ? 'chosen per task' : 'Claude Code default'}${Object.keys(c.runner.effort).length ? ` (pinned: ${Object.entries(c.runner.effort).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''} · Lean classify/plan/review calls: ${c.runner.leanCalls ? 'on' : 'off'}`,
    `Review: ${c.review.enabled ? `on (${r.reviewer})` : 'off'} · Session resume: ${c.session.resume ? `on${c.session.maxContextTokens ? ` (fresh session past ${Math.round(c.session.maxContextTokens / 1000)}k tokens)` : ''}` : 'off'} · Tests: ${c.verify.testEveryStep ? 'every step' : 'after the last plan step'} · Warm-cache hold: ${c.session.keepWarmTier ? `on (${c.session.cacheTtlSec}s)` : 'off'}`,
    `Permission mode: ${ctx.permissionMode}${ctx.modeOverridden ? ' (set with /mode)' : ''} · Limits: plan ≤${c.limits.maxPlanSteps} steps, budget/step ${c.limits.maxBudgetUsdPerStep ?? 'none'}, budget/task ${c.limits.maxBudgetUsdPerTask ?? 'none'}`,
    `Usage guard: avoid Opus at ≥${pct(c.usage.downshiftAt)}, warn at ≥${pct(c.usage.warnAt)}${t ? ` (now ${windowLabel(t.name)} ${pct(t.window.utilization)})` : ''}`,
  ];
}
