import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { fastClassify } from '../../src/core/classifier.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { reviewerTier } from '../../src/core/router.js';
import { emptyUsage } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'reviewer' | 'executor'; model: string; effort?: string; tools?: string[]; system?: string }

function setup(opts: { classifier?: Record<string, unknown>; steps?: object[]; config?: (c: SmartConfig) => void; changedFile?: string } = {}) {
  const calls: Call[] = [];
  const ok = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1, ...over });
  const cwd = mkdtempSync(join(tmpdir(), 'smart-phases-'));
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : props && 'pass' in props ? 'reviewer' : 'executor';
    calls.push({ role, model: o.model, effort: o.effort, tools: o.tools, system: o.systemPrompt });
    if (role === 'classifier') return ok({ structured: { complexity: 'small_edit', needsPlan: false, reason: 'r', ...opts.classifier } });
    if (role === 'planner') return ok({ structured: { summary: 'Plan', steps: opts.steps ?? [{ title: 'A', instructions: 'do a', acceptance: ['works'] }] } });
    if (role === 'reviewer') return ok({ structured: { pass: true, issues: [] } });
    if (opts.changedFile) {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, opts.changedFile), 'export const x = 1;\n');
      o.onEvent?.({ kind: 'tool', name: 'Write', summary: `Write ${opts.changedFile}`, writtenFile: join(cwd, opts.changedFile) });
    }
    return ok({ text: 'coded' });
  };
  const config = defaultConfig();
  config.verify.auto = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, cwd, { run, uid: 1000, listFiles: () => [] });
  return { pipeline, calls, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('fast lane', () => {
  const c = defaultConfig();

  it('recognises clearly routine one-line edits', () => {
    for (const t of ['fix the typo in the readme', 'rename foo to bar in utils.js', 'change the button colour to blue', 'bump the version number to 1.2.0', 'remove the unused import in app.ts', 'add a comment above the loop']) {
      expect(fastClassify(t, c), t).toMatchObject({ complexity: 'small_edit', needsPlan: false, difficulty: 'easy' });
    }
  });

  it('leaves everything else to the classifier: builds, questions, hard-looking work, lists of jobs, multi-line and long requests', () => {
    for (const t of [
      'make me a snake game', 'add a search box to the todo list', 'what is a closure?', 'fix the typo in the race condition handler and the deadlock detector',
      'rename foo across the entire codebase', 'fix the typo, rename x, change the colour and bump the version, then add tests', 'hey',
      'fix the typo in the readme\nand then add a section', `fix the typo ${'in the docs '.repeat(12)}`,
    ]) expect(fastClassify(t, c), t).toBeNull();
  });

  it('can be switched off', () => {
    const off = defaultConfig();
    off.routing.fastLane = false;
    expect(fastClassify('fix the typo in the readme', off)).toBeNull();
  });

  it('skips the classifier call entirely and still routes the edit', async () => {
    const t = setup();
    const res = await t.pipeline.runTask('fix the typo in the readme');
    expect(res.ok).toBe(true);
    expect(t.calls.map((x) => x.role)).toEqual(['executor']); // no classifier round trip
    expect(t.calls[0]).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(t.of('classified')[0]?.classification.reason).toContain('fast lane');
  });

  it('falls back to the classifier for anything it does not recognise', async () => {
    const t = setup();
    await t.pipeline.runTask('make the parser handle empty input');
    expect(t.calls.map((x) => x.role)).toEqual(['classifier', 'executor']);
  });
});

describe('answering', () => {
  it('an easy question is answered by the classifier itself: one call in total', async () => {
    const t = setup({ classifier: { complexity: 'trivial', difficulty: 'easy', answer: 'const cannot be reassigned.' } });
    await t.pipeline.runTask('what is the difference between let and const?');
    expect(t.calls.map((x) => x.role)).toEqual(['classifier']);
    expect(t.pipeline.lastReplyText).toBe('const cannot be reassigned.');
  });

  it('a hard question is answered by the model the rater picks, tool-free, at its effort, instead of the classifier\'s draft', async () => {
    const t = setup({ classifier: { complexity: 'trivial', difficulty: 'hard', answer: 'a quick guess' } });
    await t.pipeline.runTask('why do concurrent writers to a queue deadlock, and what are the trade-offs between locking strategies for preventing a race condition?');
    expect(t.calls.map((x) => x.role)).toEqual(['classifier', 'executor']);
    const answer = t.calls[1]!;
    expect(answer.tools).toEqual([]); // no coding session
    expect(answer.model).not.toBe('haiku');
    expect(answer.effort).toBeDefined();
    if (answer.model === 'sonnet') expect(['low', 'medium']).toContain(answer.effort); // answers are capped at medium on Sonnet
    expect(answer.system).toContain('no tools');
    expect(t.pipeline.lastReplyText).toBe('coded'); // the stronger model's answer (the scripted model says "coded"), not the classifier's draft
    expect(t.pipeline.lastReplyText).not.toBe('a quick guess');
  });
});

describe('planning', () => {
  it('says which model and effort plans', async () => {
    const t = setup({ classifier: { complexity: 'large_build', needsPlan: true } });
    await t.pipeline.runTask('build a job runner', { autoApprove: true });
    const notice = t.of('notice').find((n) => n.message.startsWith('Planning with'));
    expect(notice?.message).toBe('Planning with opus · high');
  });
});

describe('reviewing', () => {
  it('reviewerTier: the configured reviewer normally, at least Sonnet for a step rated as hard as Opus work', () => {
    const c = defaultConfig();
    expect(reviewerTier(undefined, c)).toBe('haiku');
    expect(reviewerTier(0.4, c)).toBe('haiku');
    expect(reviewerTier(0.7, c)).toBe('sonnet');
    c.routing.reviewer = 'opus';
    expect(reviewerTier(0.1, c)).toBe('opus'); // never weakened
  });

  it('an easy step is reviewed by Haiku, a hard one by Sonnet', async () => {
    const steps = [
      { title: 'Scaffold', instructions: 'set up the boilerplate folders', acceptance: ['exists'], difficulty: 'easy' },
      { title: 'Queue', instructions: 'implement the lock-free queue so workers never deadlock', acceptance: ['tests pass'], difficulty: 'hard' },
    ];
    const t = setup({ classifier: { complexity: 'large_build', needsPlan: true }, steps, changedFile: 'src/a.ts' });
    await t.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(t.calls.filter((c) => c.role === 'reviewer').map((c) => [c.model, c.effort])).toEqual([['haiku', undefined], ['sonnet', 'low']]);
  });
});
