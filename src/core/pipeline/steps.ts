import type { SmartConfig } from '../config.js';
import type { StepOutcome, StepRecord } from '../store/tracker.js';
import { emptyUsage, type Classification, type ModelTier, type PlanStep } from '../types.js';
import type { Check } from '../verifier.js';

/**
 * The reviewer is the quality gate that works without tests: every plan step is reviewed, and a single-step
 * task is reviewed when no automated check ran. Questions, steps that changed no files, and a lone edit rated easy
 * (a typo, a rename: no acceptance criteria to check, and the review call took longer than the edit) are not.
 */
export function shouldReview(config: SmartConfig, c: Classification, planSteps: number, checks: number, files: string[]): boolean {
  if (!config.review.enabled || c.complexity === 'trivial' || files.length === 0) return false;
  if (planSteps <= 1 && c.complexity === 'small_edit' && c.difficulty === 'easy') return false;
  return planSteps > 1 || checks === 0;
}

/**
 * The checks after one step. A test suite is often the slow part, so in a plan the steps before the last get the quick
 * checks (typecheck, lint, build) and the last step also the tests: what an earlier step broke still fails there and is
 * fixed before the task counts as done. Your own `verify.commands` always all run. `deferred` says tests were held back.
 */
export function selectChecks(all: Check[], lastStep: boolean, config: SmartConfig): { checks: Check[]; deferred: boolean } {
  if (lastStep || config.verify.testEveryStep || config.verify.commands.length > 0) return { checks: all, deferred: false };
  const quick = all.filter((c) => c.name !== 'test');
  return { checks: quick, deferred: quick.length < all.length };
}

/**
 * The most one coding call may spend: the per-step cap, and what is left of the task budget. Claude Code stops a call that
 * goes over (checked between its turns), so `--budget` is a real cap instead of only being checked between attempts.
 */
export function stepBudget(config: SmartConfig, spentUsd: number): number | null {
  const perStep = config.limits.maxBudgetUsdPerStep;
  const cap = config.limits.maxBudgetUsdPerTask;
  const left = cap ? Math.max(0.01, Math.round((cap - spentUsd) * 100) / 100) : null;
  return perStep && left ? Math.min(perStep, left) : (perStep ?? left);
}

/** Model forced and planning off: no classifier call. `fallback` makes the rater use the local signals alone. */
export const forcedClassification = (tier: ModelTier): Classification => ({
  complexity: 'multi_file', needsPlan: false, fallback: true, reason: `Model forced to ${tier} and planning off: no classifier call.`,
});

export const skippedRecord = (s: PlanStep): StepRecord => ({
  stepId: s.id, title: s.title, model: '-', tier: '-', attempts: 0, escalated: false, usage: emptyUsage(), outcome: 'skipped' as StepOutcome,
});
