import type { SmartConfig } from '../config.js';
import { EFFORTS, type Classification, type Difficulty, type Effort, type ModelTier } from '../types.js';
import { extractFeatures, localScore, type Signal } from './features.js';
import { adjustRung, type History } from './learn.js';

/**
 * The rater: one number for "how demanding is this work" and a rung on the cost ladder for it.
 *
 *   score = blend of  (a) local signals read from the text (rating/features.ts, free)
 *                     (b) the classifier's complexity + difficulty (a cheap model's opinion)
 *                     (c) for a plan step, the planner's own difficulty rating of that step
 *   rung  = the cheapest (model, effort) whose score band contains it, nudged by what your own history says worked.
 *
 * Effort is a minor cost lever (measured: within noise on short prompts) and a real quality lever; the model is the big
 * cost lever (Opus is about 2x Sonnet per token). So the ladder spends effort first, and only then the bigger model.
 */
export interface Rung {
  tier: ModelTier;
  effort?: Effort;
}

/** Cheapest first. Haiku has no effort setting. */
export const RUNGS: readonly Rung[] = [
  { tier: 'haiku' },
  { tier: 'sonnet', effort: 'low' },
  { tier: 'sonnet', effort: 'medium' },
  { tier: 'sonnet', effort: 'high' },
  { tier: 'opus', effort: 'medium' },
  { tier: 'opus', effort: 'high' },
  { tier: 'opus', effort: 'xhigh' },
];

/** A score at or above THRESHOLDS[i] moves to rung i+1. */
export const THRESHOLDS = [0.12, 0.25, 0.45, 0.62, 0.8, 0.92] as const;

const FLOOR_INDEX: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 4 };
const COMPLEXITY_BASE = { trivial: 0.05, small_edit: 0.2, multi_file: 0.42, large_build: 0.5 } as const;
const DIFFICULTY_OFFSET: Record<Difficulty, number> = { easy: -0.1, normal: 0, hard: 0.3 };
/** The planner's rating of a step, as a score. It wrote the step and knows the plan, so it counts for more than for a whole request. */
const STEP_SCORE: Record<Difficulty, number> = { easy: 0.15, normal: 0.35, hard: 0.75 };
const STEP_WEIGHT = 0.6;
/** `cost` needs more evidence before spending on a bigger rung; `quality` needs less. */
const BIAS = { cost: 0.06, balanced: 0, quality: -0.06 } as const;

export interface Rating {
  score: number;
  /** 0..1: do the signals agree, and is the score clear of a rung boundary? */
  confidence: number;
  rung: Rung;
  index: number;
  /** One line for the routing reason. */
  summary: string;
  /** Everything that went into it, for `smart rate` and the docs. */
  detail: string[];
}

/** What the rater needs to know about a plan step (a `PlanStep` fits, and so do partial ones). */
export interface StepInfo {
  tier?: ModelTier;
  difficulty?: Difficulty;
  files?: string[];
  acceptance?: string[];
}

export interface RateInput {
  /** The request, or the step's title and instructions. */
  text: string;
  classification?: Classification;
  step?: StepInfo;
  /** Files the request refers to (@mentions). */
  files?: string[];
  config: SmartConfig;
  history?: History;
  /** Overrides the floor that would come from the classification (used by `smart --rate`, which has no classifier). */
  floorTier?: ModelTier;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (s: Signal): string => `${s.label} ${s.weight >= 0 ? '+' : '−'}${Math.abs(s.weight).toFixed(2)}`;
export const rungLabel = (r: Rung): string => (r.effort ? `${r.tier} · ${r.effort}` : r.tier);

/** What the classifier (and, for a step, the planner) thinks, as a score. Undefined when the classifier was unusable. */
function modelOpinion(i: RateInput): { score: number; why: string; weight: number } | undefined {
  const c = i.classification;
  // A step of a written plan is rated on its own by the planner; the task's difficulty does not spread to every step.
  if (i.step) {
    const d = i.step.difficulty ?? 'normal';
    return { score: STEP_SCORE[d], why: `${d}${i.step.difficulty ? ' (planner)' : ''}`, weight: STEP_WEIGHT };
  }
  if (!c || c.fallback) return undefined;
  const difficulty = c.difficulty ?? 'normal';
  return { score: clamp(COMPLEXITY_BASE[c.complexity] + DIFFICULTY_OFFSET[difficulty], 0, 1), why: `${c.complexity}, ${difficulty}`, weight: 0.5 };
}

export function rateTask(i: RateInput): Rating {
  const features = extractFeatures({ text: i.text, files: [...(i.files ?? []), ...(i.step?.files ?? [])], criteria: i.step?.acceptance?.length, step: Boolean(i.step) });
  const local = localScore(features);
  const opinion = modelOpinion(i);

  // When the two disagree, lean towards the higher one: under-provisioning costs a retry and time, over-provisioning
  // costs a fraction more per token.
  let score = local.score;
  let agreement = 0.55;
  if (opinion) {
    const gap = Math.abs(local.score - opinion.score);
    score = clamp((1 - opinion.weight) * local.score + opinion.weight * opinion.score + 0.25 * gap, 0, 1);
    agreement = clamp(1 - 1.5 * gap, 0.3, 1);
  }

  const bias = BIAS[i.config.routing.optimize];
  const adjusted = score - bias;
  const floorTier = i.floorTier ?? (i.classification && !i.classification.fallback ? i.config.routing[i.classification.complexity] : 'sonnet');
  const floor = FLOOR_INDEX[floorTier];
  const raw = THRESHOLDS.filter((t) => adjusted >= t).length;
  let index = Math.max(raw, floor);
  const learned = adjustRung(index, floor, score, RUNGS, i.history);
  index = learned.idx;

  const margin = Math.min(...THRESHOLDS.map((t) => Math.abs(adjusted - t)));
  const confidence = round2(agreement * (0.6 + 0.4 * clamp(margin / 0.08, 0, 1)));
  const rung = RUNGS[index]!;
  const signals = local.contributions.map(fmt);
  const reasonBits = [...local.contributions.filter((c) => Math.abs(c.weight) >= 0.05).map((c) => c.label), opinion?.why].filter(Boolean);
  // Verdict first: the plan panel cuts long reasons at the end, and the choice matters more than the explanation.
  // Effort is only named when it will be applied.
  const shown = i.config.runner.autoEffort ? rungLabel(rung) : rung.tier;
  const summary = `${shown} · rated ${score.toFixed(2)} · ${Math.round(confidence * 100)}% sure (${reasonBits.join(', ') || 'no strong signals'})${learned.note ? `; ${learned.note}` : ''}`;
  const detail = [
    `local signals: ${signals.length ? signals.join(', ') : 'none'} → ${local.score.toFixed(2)}`,
    opinion ? `classifier/planner: ${opinion.why} → ${opinion.score.toFixed(2)}` : 'classifier/planner: not available, local signals only',
    `blended score ${score.toFixed(2)}${bias ? `, optimize=${i.config.routing.optimize} shifts it by ${(-bias).toFixed(2)}` : ''}`,
    `floor from routing.${i.classification?.complexity ?? 'default'}: ${floorTier}`,
    ...(learned.note ? [learned.note] : []),
    `→ ${rungLabel(rung)} (confidence ${Math.round(confidence * 100)}%)`,
  ];
  return { score: round2(score), confidence, rung, index, summary, detail };
}

/** The effort a given model would get at a given score: used when the model was fixed some other way (forced, keyword, escalation). */
export function effortAt(tier: ModelTier, score: number): Effort | undefined {
  if (tier === 'haiku') return undefined;
  if (tier === 'sonnet') return score < THRESHOLDS[1] ? 'low' : score < THRESHOLDS[2] ? 'medium' : 'high';
  return score < THRESHOLDS[4] ? 'medium' : score < THRESHOLDS[5] ? 'high' : 'xhigh';
}

/** One level up, capped where it stops paying off: Sonnet at high, Opus at xhigh. A pinned level above the cap is left alone. */
export function bumpEffort(effort: Effort | undefined, tier: ModelTier): Effort | undefined {
  if (!effort || tier === 'haiku') return effort;
  const at = EFFORTS.indexOf(effort);
  const cap = EFFORTS.indexOf(tier === 'sonnet' ? 'high' : 'xhigh');
  return at >= cap ? effort : EFFORTS[at + 1];
}
