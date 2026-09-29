import type { SmartConfig } from './config.js';
import type { Classification, ModelTier, PlanStep, RouteDecision } from './types.js';

export const modelFor = (tier: ModelTier, config: SmartConfig): string => config.models[tier];

const decision = (tier: ModelTier, config: SmartConfig, reason: string): RouteDecision => ({
  tier,
  model: modelFor(tier, config),
  reason,
});

function keywordTier(text: string, config: SmartConfig): { tier: ModelTier; match: string } | null {
  for (const rule of config.routing.keywordRules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.match, 'i');
    } catch {
      continue; // config validation rejects bad regexes; be defensive anyway
    }
    const m = re.exec(text);
    if (m) return { tier: rule.tier, match: m[0] };
  }
  return null;
}

/**
 * Pure routing function. Precedence: forced override > tier chosen for the step >
 * keyword rule > complexity map.
 */
export function route(
  args: { classification: Classification; text: string; step?: Pick<PlanStep, 'tier'>; override?: ModelTier | null },
  config: SmartConfig,
): RouteDecision {
  const { classification, text, step, override } = args;
  if (override) return decision(override, config, `forced to ${override}`);
  if (step?.tier) return decision(step.tier, config, `${step.tier} chosen for this step`);
  const kw = keywordTier(text, config);
  if (kw) return decision(kw.tier, config, `keyword "${kw.match}" → ${kw.tier}`);
  const tier = config.routing[classification.complexity];
  return decision(tier, config, `${classification.complexity} → ${tier}`);
}

/** Route for the fixed roles that are not driven by task complexity. */
export function routeRole(role: 'planner' | 'classifier', config: SmartConfig, override?: ModelTier | null): RouteDecision {
  const tier = config.routing[role];
  return override && role === 'planner' ? decision(override, config, `forced to ${override}`) : decision(tier, config, `${role} role → ${tier}`);
}

/** Next tier up the escalation ladder, or null when already at the top (or not on the ladder). */
export function escalate(tier: ModelTier, config: SmartConfig): ModelTier | null {
  const ladder = config.escalation.ladder;
  const i = ladder.indexOf(tier);
  return i === -1 ? null : (ladder[i + 1] ?? null);
}

export function isTier(value: string): value is ModelTier {
  return value === 'haiku' || value === 'sonnet' || value === 'opus';
}
