import type { SmartConfig } from './config.js';
import type { Complexity, ModelTier } from './types.js';

export type Effort = 'low' | 'medium' | 'high';
const LADDER: Effort[] = ['low', 'medium', 'high'];
const up = (e: Effort, by: number): Effort => LADDER[Math.min(LADDER.length - 1, LADDER.indexOf(e) + by)]!;

const BASE: Record<Complexity, Effort> = { trivial: 'low', small_edit: 'low', multi_file: 'medium', large_build: 'medium' };

/**
 * How hard the model should think for a coding step. Cheap where the work is easy, more where it is not:
 * base from the task's complexity, one level up on Opus (it was chosen because the step is hard) and one level up
 * after a failed attempt on the same model (think harder before paying for a bigger model).
 * Haiku gets no setting (it has no thinking budget to tune). An explicit `runner.effort[tier]` in the config always wins.
 */
export function pickEffort(a: { tier: ModelTier; complexity: Complexity; failuresOnTier: number; config: SmartConfig }): Effort | undefined {
  const explicit = a.config.runner.effort[a.tier];
  if (explicit) return explicit as Effort;
  if (!a.config.runner.autoEffort || a.tier === 'haiku') return undefined;
  let e = BASE[a.complexity];
  if (a.tier === 'opus' && a.complexity !== 'trivial') e = up(e, 1);
  return up(e, Math.min(a.failuresOnTier, 1));
}

/** Planning is where thinking pays off most: the plan decides how easy every later step is. */
export function planEffort(complexity: Complexity, config: SmartConfig): Effort | undefined {
  if (!config.runner.autoEffort) return undefined;
  return complexity === 'large_build' ? 'high' : 'medium';
}
