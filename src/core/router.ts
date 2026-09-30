import type { SmartConfig } from './config.js';
import { effortAt, rateTask, type StepInfo } from './rating/rate.js';
import type { History } from './rating/learn.js';
import type { Classification, ModelTier, RouteDecision } from './types.js';

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
 * Pure routing function. Precedence: forced override > tier chosen for the step > keyword rule > the rater.
 * The rater (rating/rate.ts) scores the work and picks the cheapest model and effort that fits the score, never below the
 * per-complexity tier in the config. The first three decide the model only; effort still follows the score.
 */
export function route(
  args: {
    classification: Classification;
    text: string;
    step?: StepInfo;
    /** The step is the whole request (no written plan): rate it as the request, not as one step of many. */
    solo?: boolean;
    override?: ModelTier | null;
    /** Files the request refers to (@mentions). */
    files?: string[];
    history?: History;
    /** Apply `routing.keywordRules` (default). Off for answering a question: the rules are about doing the work. */
    keywords?: boolean;
  },
  config: SmartConfig,
): RouteDecision {
  const { classification, text, step, override } = args;
  const rating = rateTask({ text, classification, step: args.solo ? undefined : step, files: args.files, config, history: args.history });
  const withRating = (d: RouteDecision): RouteDecision => ({
    ...d,
    score: rating.score,
    confidence: rating.confidence,
    ratedTier: d.tier,
    effort: d.tier === rating.rung.tier ? rating.rung.effort : effortAt(d.tier, rating.score),
  });
  if (override) return withRating(decision(override, config, `forced to ${override}`, 'override'));
  if (step?.tier) return withRating(decision(step.tier, config, `${step.tier} chosen for this step`, 'step'));
  const kw = args.keywords === false ? null : keywordTier(text, config);
  if (kw) return withRating(decision(kw.tier, config, `keyword "${kw.match}" → ${kw.tier}`, 'keyword'));
  // Unusable classifier output: the local signals still rate the work (a deadlock hunt is not a typo fix); Sonnet is the floor.
  if (classification.fallback) return withRating(decision(rating.rung.tier, config, `classifier output unusable, ${rating.summary}`, 'fallback'));
  return withRating(decision(rating.rung.tier, config, rating.summary, 'complexity'));
}

/** A question the classifier already answered is re-answered by a stronger model only when the rating is clearly above routine (Sonnet medium and up). */
export const ANSWER_UPGRADE_SCORE = 0.25;

/** A step rated this hard (Opus territory) is reviewed by at least Sonnet: Haiku is too weak to check work it could not do. */
export const REVIEW_UPGRADE_SCORE = 0.62;

export function reviewerTier(score: number | undefined, config: SmartConfig): ModelTier {
  const configured = config.routing.reviewer;
  return score !== undefined && score >= REVIEW_UPGRADE_SCORE && RANK[configured] < RANK.sonnet ? 'sonnet' : configured;
}

/** A task rated this hard is planned by the strong planner even when it is not a big build. */
export const HEAVY_PLAN_SCORE = 0.62;

/** Which planner a task gets: the strong one for big builds and hard tasks, the light one for the rest. */
export function plannerTier(classification: Pick<Classification, 'complexity' | 'difficulty'> | undefined, config: SmartConfig, score?: number): ModelTier {
  const heavy = !classification || classification.complexity === 'large_build' || classification.difficulty === 'hard' || (score !== undefined && score >= HEAVY_PLAN_SCORE);
  return heavy ? config.routing.planner : config.routing.plannerLight;
}

/** Route for the fixed roles that are not driven by task complexity (the planner also looks at how big and hard the task is). */
export function routeRole(role: 'planner' | 'classifier' | 'reviewer', config: SmartConfig, override?: ModelTier | null, classification?: Classification, score?: number): RouteDecision {
  if (override && role === 'planner') return decision(override, config, `forced to ${override}`);
  const tier = role === 'planner' ? plannerTier(classification, config, score) : config.routing[role];
  return decision(tier, config, `${role} role → ${tier}`);
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
    ...decision,
    tier: session.lastTier,
    model: modelFor(session.lastTier, config),
    reason: `${decision.reason}; kept ${session.lastTier}: its cache holds this conversation, switching down would cost more`,
    source: 'session',
  };
}
