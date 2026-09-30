import { describe, expect, it } from 'vitest';
import { billable, summarize } from '../../src/core/stats.js';
import type { StepRecord, TaskRecord } from '../../src/core/tracker.js';
import { emptyUsage, type Usage } from '../../src/core/types.js';

const NOW = new Date(2026, 5, 15, 14, 0, 0).getTime(); // a fixed local time
const u = (over: Partial<Usage>): Usage => ({ ...emptyUsage(), ...over });
const step = (model: string, usage: Usage, over: Partial<StepRecord> = {}): StepRecord => ({ stepId: 's', title: 't', model, tier: model, attempts: 1, escalated: false, usage, outcome: 'done', ...over });
const task = (id: string, startedAt: number, steps: StepRecord[], over: Partial<TaskRecord> = {}): TaskRecord => {
  const overhead = over.overhead ?? u({ costUsd: 0.01 });
  const totals = u({ costUsd: steps.reduce((n, s) => n + s.usage.costUsd, 0) + overhead.costUsd, inputTokens: 100, outputTokens: 50 });
  return { id, startedAt: new Date(startedAt).toISOString(), prompt: `task ${id}`, overhead, steps, totals, ok: true, ...over };
};
const hours = (h: number) => h * 3_600_000;

describe('billable', () => {
  it('counts fresh input, cache writes and output, not cache reads', () => {
    expect(billable(u({ inputTokens: 1, cacheCreationTokens: 2, outputTokens: 4, cacheReadTokens: 999 }))).toBe(7);
  });
});

describe('summarize', () => {
  const tasks = [
    task('old', NOW - 20 * 86_400_000, [step('sonnet', u({ costUsd: 1 }))]),
    task('week', NOW - 3 * 86_400_000, [step('sonnet', u({ costUsd: 0.5 })), step('opus', u({ costUsd: 0.4 }), { escalated: true })]),
    task('today', NOW - hours(2), [step('haiku', u({ costUsd: 0.05 })), step('sonnet', u({ costUsd: 0.2 }))], { ok: false }),
  ];
  const s = summarize(tasks, { now: NOW });

  it('splits totals into today, the last 7 days and all time', () => {
    expect(s.today).toMatchObject({ tasks: 1, ok: 0 });
    expect(s.today.cost).toBeCloseTo(0.26);
    expect(s.week.tasks).toBe(2);
    expect(s.all).toMatchObject({ tasks: 3, ok: 2 });
    expect(s.all.cost).toBeCloseTo(1.01 + 0.91 + 0.26);
    expect(s.avgTaskCost).toBeCloseTo(s.all.cost / 3);
  });

  it('breaks steps down per model, sorted by cost, with overhead separate', () => {
    expect(s.byModel.map((m) => m.model)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(s.byModel[0]).toMatchObject({ steps: 3 });
    expect(s.byModel[0]!.cost).toBeCloseTo(1.7);
    expect(s.overhead).toBeCloseTo(0.03);
  });

  it('counts escalations and ignores skipped steps', () => {
    const withSkipped = summarize([task('x', NOW, [step('sonnet', u({ costUsd: 1 })), step('-', u({}), { outcome: 'skipped', escalated: false })])], { now: NOW });
    expect(withSkipped.steps).toBe(1);
    expect(s.steps).toBe(5);
    expect(s.escalatedSteps).toBe(1);
  });

  it('lists the most expensive tasks first', () => {
    expect(s.top.map((t) => t.prompt)).toEqual(['task old', 'task week', 'task today']);
    expect(s.top[2]?.ok).toBe(false);
  });

  it('handles empty history', () => {
    const e = summarize([], { now: NOW });
    expect(e.all.tasks).toBe(0);
    expect(e.avgTaskCost).toBe(0);
  });
});
