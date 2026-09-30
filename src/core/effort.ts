import type { SmartConfig } from './config.js';
import { HEAVY_PLAN_SCORE } from './router.js';
import { bumpEffort, effortAt } from './rating/rate.js';
import type { Complexity, Effort, ModelTier, RouteDecision } from './types.js';

/**
 * The thinking effort for one attempt of a coding step. The rater already chose an effort with the model
 * (`decision.effort`, from the score); this adjusts it for what happened since:
 *   - a pinned `runner.effort[tier]` always wins;
 *   - Haiku has no setting, and `runner.autoEffort: false` leaves Claude Code's default;
 *   - after a failed attempt on the same model, one level up (think harder before paying for a bigger model);
 *   - after escalating to a stronger model, that model's effort for the score, one level up (the step already failed once).
 * If the warm-cache or usage-limit rules changed the model, the effort is recomputed for the model actually used.
 */
export function effortFor(a: { decision: RouteDecision; tier: ModelTier; failuresOnTier: number; escalated: boolean; config: SmartConfig }): Effort | undefined {
  const pinned = a.config.runner.effort[a.tier];
  if (pinned) return pinned as Effort;
  if (!a.config.runner.autoEffort || a.tier === 'haiku') return undefined;
  const score = a.decision.score ?? 0.5;
  const rated = a.tier === a.decision.ratedTier ? a.decision.effort : undefined;
  let e = rated ?? effortAt(a.tier, score);
  if (a.escalated || a.failuresOnTier > 0) e = bumpEffort(e, a.tier);
  return e;
}

/**
 * A tool-free answer to a question. Explaining something rarely needs a long think, and a live measurement showed
 * Sonnet at high effort taking 21 s for a paragraph, so Sonnet answers are capped at medium (Opus keeps its rated level).
 */
export function answerEffort(a: { decision: RouteDecision; tier: ModelTier; config: SmartConfig }): Effort | undefined {
  const e = effortFor({ decision: a.decision, tier: a.tier, failuresOnTier: 0, escalated: false, config: a.config });
  return a.tier === 'sonnet' && (e === 'high' || e === 'xhigh' || e === 'max') && !a.config.runner.effort.sonnet ? 'medium' : e;
}

/** Planning is where thinking pays off most: the plan decides how easy every later step is. */
export function planEffort(complexity: Complexity, config: SmartConfig, score?: number): Effort | undefined {
  if (!config.runner.autoEffort) return undefined;
  return complexity === 'large_build' || (score !== undefined && score >= HEAVY_PLAN_SCORE) ? 'high' : 'medium';
}
