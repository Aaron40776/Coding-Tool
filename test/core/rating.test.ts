import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { extractFeatures, localScore } from '../../src/core/rating/features.js';
import { adjustRung, band, buildHistory, posterior, statsKey } from '../../src/core/rating/learn.js';
import { bumpEffort, effortAt, RUNGS, rateTask, rungLabel, THRESHOLDS } from '../../src/core/rating/rate.js';
import type { StepRecord, TaskRecord } from '../../src/core/store/tracker.js';
import { emptyUsage, type Classification } from '../../src/core/types.js';
import { parsePlan } from '../../src/core/planner.js';

const config = defaultConfig();
const cls = (over: Partial<Classification> = {}): Classification => ({ complexity: 'small_edit', needsPlan: false, reason: '', ...over });
const rate = (text: string, c: Partial<Classification> = {}, extra: Partial<Parameters<typeof rateTask>[0]> = {}) => rateTask({ text, classification: cls(c), config, ...extra });
const local = (text: string) => localScore(extractFeatures({ text })).score;

describe('local signals', () => {
  it('recognise hard work by what it is about', () => {
    for (const t of [
      'fix the race condition in the cache', 'find the deadlock', 'patch the SQL injection vulnerability', 'redesign the architecture', 'implement a parser for the config language',
      'the test fails intermittently and I cannot reproduce it', 'refactor across all files', 'migrate the database schema', 'the request handler has a memory leak',
    ]) expect(local(t), t).toBeGreaterThan(local('do the thing'));
  });

  it('recognise routine work', () => {
    for (const t of ['fix the typo', 'rename the variable', 'change the button colour', 'add a comment', 'bump the version number']) expect(local(t), t).toBeLessThan(local('do the thing'));
  });

  it('a stack trace counts as investigation work', () => {
    const trace = 'crash\n    at getUser (src/users.js:42:17)\n    at handler (src/routes.js:88:5)';
    expect(local(trace)).toBeGreaterThan(local('crash'));
    expect(extractFeatures({ text: 'Traceback (most recent call last):\n  File "a.py", line 3' }).hard.map((s) => s.label)).toContain('stack trace');
  });

  it('a question that changes nothing is easy, but a question that asks for a change is not', () => {
    expect(extractFeatures({ text: 'what does this function do?' }).easy.map((s) => s.label)).toContain('question only');
    expect(extractFeatures({ text: 'how do I add tests? please add them' }).easy.map((s) => s.label)).not.toContain('question only');
    expect(extractFeatures({ text: 'what is the difference between let and const?' }).parts).toBe(1); // "and" inside a question is not two jobs
  });

  it('more files, more parts and longer requests raise the score', () => {
    const base = local('add a button');
    expect(localScore(extractFeatures({ text: 'add a button', files: ['a', 'b', 'c', 'd', 'e', 'f'] })).score).toBeGreaterThan(base);
    expect(local('add a button and a form and a table, then wire them up; also add tests')).toBeGreaterThan(base);
    expect(local('add a button '.repeat(50))).toBeGreaterThan(base);
  });

  it('several hard signals count with diminishing weight and the score stays within 0..1', () => {
    const all = 'security vulnerability and a race condition and deadlock, redesign the architecture across the entire codebase, migrate the schema, memory leak, algorithm, intermittent root cause';
    const s = local(all);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThan(local('security vulnerability'));
    expect(local('fix the typo, rename, comment, whitespace formatting, lint error, simple, tiny')).toBeGreaterThanOrEqual(0);
  });
});

describe('rateTask', () => {
  it('maps the score onto the ladder in order: a higher score never gets a cheaper rung', () => {
    const texts = ['fix the typo', 'add a button', 'add a form with validation and tests across the app', 'find the race condition causing intermittent deadlock', 'redesign the architecture, migrate the schema, and fix the security vulnerability across the entire codebase'];
    const rated = texts.map((t) => rate(t, { difficulty: 'normal' }));
    const sorted = [...rated].sort((a, b) => a.score - b.score);
    expect(sorted.map((r) => r.index)).toEqual([...sorted.map((r) => r.index)].sort((a, b) => a - b));
  });

  it('a harder classifier opinion or harder text never lowers the rung (monotonic)', () => {
    const idx = (text: string, difficulty: 'easy' | 'normal' | 'hard') => rate(text, { difficulty }).index;
    expect(idx('improve the module', 'easy')).toBeLessThanOrEqual(idx('improve the module', 'normal'));
    expect(idx('improve the module', 'normal')).toBeLessThanOrEqual(idx('improve the module', 'hard'));
    expect(idx('improve the module', 'normal')).toBeLessThanOrEqual(idx('improve the module for a race condition', 'normal'));
  });

  it('when the text and the classifier disagree it leans towards the higher one, and is less sure', () => {
    const agree = rate('fix the typo in the readme', { difficulty: 'easy' });
    const disagree = rate('fix the typo in the readme', { difficulty: 'hard' });
    expect(disagree.score).toBeGreaterThan(agree.score);
    expect(disagree.confidence).toBeLessThan(agree.confidence);
    expect(agree.confidence).toBeGreaterThan(0.5);
  });

  it('works from the text alone when the classifier was unusable, with lower confidence', () => {
    const r = rateTask({ text: 'find the intermittent deadlock', classification: { ...cls(), fallback: true }, config });
    expect(r.rung.tier).toBe('opus');
    expect(r.detail.join(' ')).toContain('not available');
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('explains itself: the verdict comes first, then the score, the confidence and the signals', () => {
    const r = rate('the workers stall intermittently, find the root cause of this concurrency bug', { difficulty: 'hard' });
    expect(r.summary).toMatch(/^(opus|sonnet) · \w+ · rated \d\.\d\d · \d+% sure \(/);
    expect(r.summary).toContain('concurrency');
    expect(r.detail.length).toBeGreaterThanOrEqual(5);
    expect(r.detail.at(-1)).toContain(rungLabel(r.rung));
  });

  it('the ladder is ordered cheapest first and the thresholds are increasing', () => {
    expect(RUNGS).toHaveLength(THRESHOLDS.length + 1);
    expect([...THRESHOLDS]).toEqual([...THRESHOLDS].sort((a, b) => a - b));
    expect(RUNGS.map((r) => r.tier)).toEqual(['haiku', 'sonnet', 'sonnet', 'sonnet', 'opus', 'opus', 'opus']);
  });

  it('the effort of a fixed model follows the score, and a retry bump stops where it stops paying off', () => {
    expect(effortAt('haiku', 0.9)).toBeUndefined();
    expect([effortAt('sonnet', 0.1), effortAt('sonnet', 0.3), effortAt('sonnet', 0.5)]).toEqual(['low', 'medium', 'high']);
    expect([effortAt('opus', 0.7), effortAt('opus', 0.85), effortAt('opus', 0.95)]).toEqual(['medium', 'high', 'xhigh']);
    expect(bumpEffort('low', 'sonnet')).toBe('medium');
    expect(bumpEffort('high', 'sonnet')).toBe('high');
    expect(bumpEffort('high', 'opus')).toBe('xhigh');
    expect(bumpEffort('xhigh', 'opus')).toBe('xhigh');
    expect(bumpEffort('max', 'opus')).toBe('max');
    expect(bumpEffort(undefined, 'sonnet')).toBeUndefined();
  });
});

interface Case {
  text: string;
  classification: { complexity: Classification['complexity']; difficulty: 'easy' | 'normal' | 'hard' };
  want: [number, number];
}
const cases = (file: string): Case[] => JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8')) as Case[];
const accuracy = (set: Case[]): { hit: number; misses: string[] } => {
  const misses: string[] = [];
  let hit = 0;
  for (const c of set) {
    const r = rate(c.text, c.classification);
    if (r.index >= c.want[0] && r.index <= c.want[1]) hit += 1;
    else misses.push(`${rungLabel(r.rung)} (wanted ${c.want.join('-')}): ${c.text.slice(0, 60)}`);
  }
  return { hit, misses };
};

describe('rating quality on labelled prompts', () => {
  // Labels are the author's judgement of what a sensible person would pick. `rating-cases` was used while tuning the signals;
  // `rating-heldout` was written before the rater ran on it and only one real defect (counting "and" in a question as a
  // second job) was fixed afterwards. Treat these as a regression net, not proof of accuracy on your own prompts.
  it('tuning set: at least 90% land in the expected range', () => {
    const set = cases('rating-cases.json');
    const { hit, misses } = accuracy(set);
    expect(hit / set.length, misses.join('\n')).toBeGreaterThanOrEqual(0.9);
  });

  it('held-out set: at least 80% land in the expected range, and no hard task goes below Sonnet high', () => {
    const set = cases('rating-heldout.json');
    const { hit, misses } = accuracy(set);
    expect(hit / set.length, misses.join('\n')).toBeGreaterThanOrEqual(0.8);
    for (const c of set.filter((x) => x.want[0] >= 4)) expect(rate(c.text, c.classification).index, c.text).toBeGreaterThanOrEqual(3);
  });

  it('never sends an easy typo-style edit to Opus, or a deadlock hunt to Haiku', () => {
    for (const c of [...cases('rating-cases.json'), ...cases('rating-heldout.json')]) {
      const r = rate(c.text, c.classification);
      if (c.want[1] <= 2) expect(r.rung.tier, c.text).not.toBe('opus');
      if (c.want[0] >= 4) expect(r.rung.tier, c.text).not.toBe('haiku');
    }
  });
});

describe('learning from history', () => {
  const NOW = Date.parse('2026-06-15T12:00:00Z');
  const step = (rated: { tier: string; effort?: string; score: number }, ok: boolean, attempts = ok ? 1 : 2): StepRecord => ({
    stepId: 's', title: 't', model: rated.tier, tier: rated.tier, attempts, escalated: !ok, usage: emptyUsage(), outcome: ok ? 'done' : 'failed', rated,
  });
  const task = (steps: StepRecord[], daysAgo = 1): TaskRecord => ({
    id: 't', startedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(), prompt: 'p', overhead: emptyUsage(), steps, totals: emptyUsage(), ok: true,
  });
  const mid = { tier: 'sonnet', effort: 'medium', score: 0.35 };

  it('counts a step as a success only when it passed on the first attempt', () => {
    const h = buildHistory([task([step(mid, true), step(mid, true), step(mid, false), step({ ...mid, score: 0.9 }, true)])], NOW);
    expect(h.get(statsKey('sonnet', 'medium', 0.35))).toEqual({ n: 3, ok: 2 });
    expect(h.get(statsKey('sonnet', 'medium', 0.9))).toEqual({ n: 1, ok: 1 }); // a different score band is a different bucket
    expect(band(0.29)).toBe('low');
    expect(band(0.3)).toBe('mid');
    expect(band(0.6)).toBe('high');
  });

  it('ignores steps older than 30 days, cancelled and skipped steps, and steps recorded before ratings existed', () => {
    const cancelled: StepRecord = { ...step(mid, false), outcome: 'cancelled' };
    const old = task([step(mid, false)], 45);
    const legacy = task([{ ...step(mid, true), rated: undefined }]);
    expect(buildHistory([old, task([cancelled]), legacy], NOW).size).toBe(0);
  });

  it('raises a rung that keeps failing: one rung up, and says why', () => {
    const many = Array.from({ length: 9 }, (_, i) => step(mid, i < 4)); // 4 of 9 pass first time
    const h = buildHistory([task(many)], NOW);
    expect(posterior(h.get(statsKey('sonnet', 'medium', 0.35))!)).toBeLessThan(0.72);
    const r = adjustRung(2, 1, 0.35, RUNGS, h);
    expect(r.idx).toBe(3);
    expect(r.note).toMatch(/only 4 of 9/);
  });

  it('does not move on too little evidence or on a good record', () => {
    const few = buildHistory([task(Array.from({ length: 4 }, () => step(mid, false)))], NOW);
    expect(adjustRung(2, 1, 0.35, RUNGS, few).idx).toBe(2);
    const fine = buildHistory([task(Array.from({ length: 10 }, (_, i) => step(mid, i !== 0)))], NOW);
    expect(adjustRung(2, 1, 0.35, RUNGS, fine).idx).toBe(2);
    expect(adjustRung(2, 1, 0.35, RUNGS, undefined).idx).toBe(2);
  });

  it('lowers effort (same model only) after a long clean record, never below the floor and never to a cheaper model', () => {
    const clean = buildHistory([task(Array.from({ length: 20 }, () => step(mid, true)))], NOW);
    expect(adjustRung(2, 1, 0.35, RUNGS, clean).idx).toBe(1); // sonnet medium -> sonnet low
    expect(adjustRung(2, 2, 0.35, RUNGS, clean).idx).toBe(2); // floor is sonnet medium
    const opusMedium = { tier: 'opus', effort: 'medium', score: 0.7 };
    const cleanOpus = buildHistory([task(Array.from({ length: 20 }, () => step(opusMedium, true)))], NOW);
    expect(adjustRung(4, 1, 0.7, RUNGS, cleanOpus).idx).toBe(4); // opus medium has no cheaper effort; it never drops to sonnet
  });

  it('is applied by the rater and shows in the explanation', () => {
    const text = 'add a form with validation and tests across the app';
    const before = rate(text, { complexity: 'multi_file' });
    const bad = Array.from({ length: 10 }, () => step({ tier: before.rung.tier, effort: before.rung.effort, score: before.score }, false));
    const after = rate(text, { complexity: 'multi_file' }, { history: buildHistory([task(bad)], NOW) });
    expect(after.index).toBe(before.index + 1);
    expect(after.summary).toContain('history:');
  });
});

describe('plan steps', () => {
  const big = cls({ complexity: 'large_build', needsPlan: true });
  const step = (text: string, difficulty: 'easy' | 'normal' | 'hard') => rateTask({ text, classification: big, step: { difficulty, files: [], acceptance: ['a', 'b'] }, config });
  const wordy = 'Add exponential backoff and jitter and a max-attempts cap, and a scheduler for delayed and interval jobs, and unit tests for the timing, and wire both to the queue; also add logging and a config file and an entry point and a README section. '.repeat(3);

  it('are not made harder by being wordy or listing several parts: a plan is already broken down', () => {
    expect(step(wordy, 'normal').rung.tier).toBe('sonnet');
    expect(step(wordy, 'normal').index).toBeLessThanOrEqual(2);
    expect(extractFeatures({ text: wordy, step: true }).step).toBe(true);
    expect(localScore(extractFeatures({ text: wordy, step: true })).contributions.map((c) => c.label).join()).not.toMatch(/parts|request/);
    // the same words as a whole request do count
    expect(localScore(extractFeatures({ text: wordy })).score).toBeGreaterThan(localScore(extractFeatures({ text: wordy, step: true })).score);
  });

  it('follow the planner\'s rating: easy on Sonnet low, normal on Sonnet medium, hard on Opus', () => {
    const t = 'Queue\nimplement the work queue';
    expect(step(t, 'easy')).toMatchObject({ rung: { tier: 'sonnet', effort: 'low' } });
    expect(step(t, 'normal')).toMatchObject({ rung: { tier: 'sonnet', effort: 'medium' } });
    expect(step(t, 'hard').rung.tier).toBe('opus');
  });

  it('still notice hard content the planner under-rated, and cheap content it over-rated', () => {
    expect(step('Fix\nremove the race condition and the deadlock in the worker pool', 'normal').score).toBeGreaterThan(step('Fix\nadd the button', 'normal').score);
    // the planner's word carries most of the weight, but the text still moves the score
    expect(step('Rename\nrename the variable and fix the typo', 'hard').score).toBeLessThan(step('Queue\nremove the race condition and the deadlock in the worker pool', 'hard').score);
    expect(step('Scaffold\nset up the boilerplate folders', 'easy').rung.effort).toBe('low');
  });

  it('the task-level difficulty does not spread to every step', () => {
    const hardTask = cls({ complexity: 'large_build', difficulty: 'hard' });
    const r = rateTask({ text: 'Scaffold\nset up the folders', classification: hardTask, step: { difficulty: 'easy' }, config });
    expect(r.rung.tier).toBe('sonnet');
  });
});

describe('planner step difficulty', () => {
  it('is kept when valid and dropped (not the whole plan) when invalid', () => {
    const plan = parsePlan({ summary: 's', steps: [{ title: 'a', instructions: 'x', difficulty: 'hard' }, { title: 'b', instructions: 'y', difficulty: 'impossible' }, { title: 'c', instructions: 'z' }] }, 6)!;
    expect(plan.plan.steps.map((s) => s.difficulty)).toEqual(['hard', undefined, undefined]);
  });
});
