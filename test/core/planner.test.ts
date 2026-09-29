import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { makePlan, parsePlan, singleStepPlan } from '../../src/core/planner.js';
import { emptyUsage, type Classification } from '../../src/core/types.js';

const cls: Classification = { complexity: 'large_build', needsPlan: true, reason: 'x' };
const result = (structured: unknown): ClaudeResult => ({
  isError: false, subtype: 'success', text: '', structured, usage: { ...emptyUsage(), costUsd: 0.05 }, sessionId: 's', numTurns: 1,
});
const good = {
  summary: 'Snake game',
  features: ['movement'],
  fileStructure: ['index.html'],
  steps: [
    { id: 'x', title: 'Scaffold', instructions: 'Create index.html', acceptance: ['opens'] },
    { id: 'x', title: 'Logic', instructions: 'Add game loop', files: ['index.html'], acceptance: ['snake moves'] },
  ],
};

describe('parsePlan', () => {
  it('normalises ids to unique s1..sn and fills defaults', () => {
    const p = parsePlan(good, 8)!.plan;
    expect(p.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(p.steps[0]?.files).toEqual([]);
  });
  it('truncates to maxPlanSteps and reports it', () => {
    const r = parsePlan(good, 1)!;
    expect(r.plan.steps).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
  it.each([[undefined], [{}], [{ steps: [] }], [{ steps: [{ title: '' , instructions: 'x' }] }], ['text']])('rejects %j', (bad) => {
    expect(parsePlan(bad, 8)).toBeNull();
  });
});

describe('makePlan', () => {
  const ctx = (run: RunClaudeFn) => ({ config: defaultConfig(), cwd: '.', run });

  it('uses the planner model with no tools and includes project files', async () => {
    let seen: Parameters<RunClaudeFn>[0] | undefined;
    const out = await makePlan('make a snake game', cls, {
      ...ctx(async (o) => { seen = o; return result(good); }),
      projectFiles: ['package.json'],
    });
    expect(out.plan.steps).toHaveLength(2);
    expect(out.usage.costUsd).toBe(0.05);
    expect(seen?.model).toBe('opus');
    expect(seen?.tools).toEqual([]);
    expect(seen?.prompt).toContain('package.json');
    expect(seen?.prompt).toContain('make a snake game');
  });

  it('honours a model override for the planner', async () => {
    let model = '';
    await makePlan('x', cls, { ...ctx(async (o) => { model = o.model; return result(good); }), override: 'sonnet' });
    expect(model).toBe('sonnet');
  });

  it('degrades to a single step on malformed output', async () => {
    const out = await makePlan('do it', cls, ctx(async () => result({ nope: true })));
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0]?.instructions).toBe('do it');
    expect(out.warning).toMatch(/malformed/);
  });

  it('degrades on a generic failure and propagates fatal ones', async () => {
    const out = await makePlan('do it', cls, ctx(async () => { throw new SmartError('claude', 'boom'); }));
    expect(out.warning).toMatch(/boom/);
    await expect(makePlan('x', cls, ctx(async () => { throw new SmartError('auth', 'no'); }))).rejects.toMatchObject({ kind: 'auth' });
    await expect(makePlan('x', cls, ctx(async () => { throw new SmartError('cancelled', 'no'); }))).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('singleStepPlan', () => {
  it('wraps the prompt as one step', () => {
    expect(singleStepPlan('fix bug').steps[0]?.instructions).toBe('fix bug');
  });
});
