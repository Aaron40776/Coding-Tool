import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Tracker, type StepRecord, type TaskRecord } from '../../src/core/store/tracker.js';
import { emptyUsage } from '../../src/core/types.js';

const usage = (costUsd: number, out = 10) => ({ ...emptyUsage(), costUsd, outputTokens: out });
const step = (model: string, cost: number, outcome: StepRecord['outcome'] = 'done'): StepRecord => ({
  stepId: 's', title: 't', model, tier: model, attempts: 1, escalated: false, usage: usage(cost), outcome,
});
const task = (id: string, steps: StepRecord[], ok = true): TaskRecord => ({
  id, startedAt: '2026-01-01T00:00:00Z', prompt: 'p', overhead: usage(0), steps,
  totals: usage(steps.reduce((a, s) => a + s.usage.costUsd, 0)), ok,
});
const dir = () => mkdtempSync(join(tmpdir(), 'smart-trk-'));

describe('Tracker', () => {
  it('returns empty history when the file does not exist', () => {
    expect(new Tracker(join(dir(), 'h.json')).load()).toEqual([]);
  });

  it('appends and reloads records, creating parent directories', () => {
    const path = join(dir(), 'nested', 'h.json');
    const t = new Tracker(path);
    expect(t.append(task('a', [step('sonnet', 0.1)]))).toBeNull();
    expect(t.append(task('b', [step('haiku', 0.01)]))).toBeNull();
    expect(t.load().map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('truncates long prompts', () => {
    const t = new Tracker(join(dir(), 'h.json'));
    t.append({ ...task('a', []), prompt: 'x'.repeat(2000) });
    expect(t.load()[0]?.prompt).toHaveLength(500);
  });

  it('recovers from a corrupt file by moving it aside', () => {
    const d = dir();
    const path = join(d, 'h.json');
    writeFileSync(path, '{not json');
    const t = new Tracker(path);
    expect(t.load()).toEqual([]);
    expect(t.append(task('a', []))).toBeNull();
    expect(t.load()).toHaveLength(1);
    expect(readdirSync(d).some((f) => f.includes('corrupt'))).toBe(true);
  });

  it('reports (not throws) when the path is unwritable', () => {
    const d = dir();
    const blocker = join(d, 'file');
    writeFileSync(blocker, 'x'); // a regular file where a directory is needed
    const err = new Tracker(join(blocker, 'h.json')).append(task('a', []));
    expect(err).toMatch(/Could not write history/);
  });
});
