import type { SmartConfig } from './config.js';
import type { Classification, ModelTier, PlanStep, RouteDecision } from './types.js';

export const modelFor = (tier: ModelTier, config: SmartConfig): string => config.models[tier];

const decision = (tier: ModelTier, config: SmartConfig, reason: string, source?: RouteDecision['source']): RouteDecision => ({
  tier,
  model: modelFor(tier, config),
  reason,
  source,
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
 * keyword rule > classifier-fallback (sonnet) > complexity map.
 */
export function route(
  args: { classification: Classification; text: string; step?: Pick<PlanStep, 'tier'>; override?: ModelTier | null },
  config: SmartConfig,
): RouteDecision {
  const { classification, text, step, override } = args;
  if (override) return decision(override, config, `forced to ${override}`, 'override');
  if (step?.tier) return decision(step.tier, config, `${step.tier} chosen for this step`, 'step');
  const kw = keywordTier(text, config);
  if (kw) return decision(kw.tier, config, `keyword "${kw.match}" → ${kw.tier}`, 'keyword');
  // Unusable classifier output always lands on Sonnet, whatever the complexity map says.
  if (classification.fallback) return decision('sonnet', config, 'classifier output unusable → sonnet', 'fallback');
  const tier = config.routing[classification.complexity];
  return decision(tier, config, `${classification.complexity} → ${tier}`, 'complexity');
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

const RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

export interface WarmSession {
  lastTier?: ModelTier;
  /** Epoch ms of the last Claude call in the session. */
  lastCallAt?: number;
  /** Epoch ms of the last call per model: a model called recently has a warm cache for this session too. */
  lastCallAtByTier?: Partial<Record<ModelTier, number>>;
}

/**
 * Prompt caches are per model. While a session's cache is warm, switching to a cheaper model
 * re-reads the whole history at full price and usually costs more than staying put. So automatic
 * routing may not downgrade to a model that would start cold; upgrades, forced models, user choices,
 * and switches to a model that is itself warm in this session always apply.
 */
export function applyWarmCache(decision: RouteDecision, session: WarmSession | null, nowMs: number, config: SmartConfig): RouteDecision {
  if (!config.session.keepWarmTier || !session?.lastTier || session.lastCallAt === undefined) return decision;
  if (decision.source !== 'complexity' && decision.source !== 'fallback') return decision;
  if (RANK[decision.tier] >= RANK[session.lastTier]) return decision;
  const ttl = config.session.cacheTtlSec * 1000;
  if (nowMs - session.lastCallAt > ttl) return decision;
  const target = session.lastCallAtByTier?.[decision.tier];
  if (target !== undefined && nowMs - target <= ttl) return decision; // the cheaper model is warm as well
  return {
    tier: session.lastTier,
    model: modelFor(session.lastTier, config),
    reason: `${decision.reason}; kept ${session.lastTier}: its cache holds this conversation, switching down would cost more`,
    source: 'session',
  };
}
