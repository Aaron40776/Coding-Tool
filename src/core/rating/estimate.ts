import type { TaskRecord } from '../store/tracker.js';
import type { ModelTier } from '../types.js';

/**
 * What one coding step usually costs on a given model and effort, from your own history: the median cost of recent steps
 * that passed on their first attempt (a retry or escalation is extra, and the estimate says it assumes none).
 */
export type CostTable = Map<string, number[]>;

export interface StepEstimate {
  usd: number;
  /** How many of your own steps the figure comes from; 0 = a rough built-in guess. */
  basis: number;
}

const key = (tier: string, effort: string | undefined): string => `${tier}/${effort ?? '-'}`;
const KEEP = 50;
const MIN_BASIS = 3;
const WINDOW_MS = 60 * 86_400_000;

/**
 * Used until you have a few steps of your own on a rung. Rough: from a handful of live runs (a Sonnet-low typo fix cost
 * about $0.05) and Opus costing about twice Sonnet per token. Your history replaces them quickly.
 */
const ROUGH: Record<string, number> = {
  'haiku/-': 0.02,
  'sonnet/low': 0.05, 'sonnet/medium': 0.08, 'sonnet/high': 0.12,
  'opus/medium': 0.18, 'opus/high': 0.25, 'opus/xhigh': 0.35,
};
const ROUGH_BY_TIER: Record<ModelTier, number> = { haiku: 0.02, sonnet: 0.08, opus: 0.25 };

export function buildCostTable(tasks: TaskRecord[], nowMs = Date.now()): CostTable {
  const table: CostTable = new Map();
  for (const t of tasks) {
    if (nowMs - Date.parse(t.startedAt) > WINDOW_MS) continue;
    for (const s of t.steps) {
      if (!s.rated || s.outcome !== 'done' || s.attempts !== 1 || !(s.usage.costUsd > 0)) continue;
      const k = key(s.rated.tier, s.rated.effort);
      const list = table.get(k) ?? [];
      list.push(s.usage.costUsd);
      table.set(k, list.slice(-KEEP));
    }
  }
  return table;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function estimateStep(route: { tier: ModelTier; effort?: string }, table: CostTable | undefined): StepEstimate {
  const mine = table?.get(key(route.tier, route.effort));
  if (mine && mine.length >= MIN_BASIS) return { usd: median(mine), basis: mine.length };
  return { usd: ROUGH[key(route.tier, route.effort)] ?? ROUGH_BY_TIER[route.tier], basis: 0 };
}

/** "≈ $0.42" or "≈ $0.42 (rough)" when any part is a built-in guess. */
export function formatEstimate(parts: StepEstimate[]): string {
  const usd = parts.reduce((n, p) => n + p.usd, 0);
  const text = usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
  return `≈ ${text}${parts.some((p) => p.basis === 0) ? ' (rough)' : ''}`;
}
