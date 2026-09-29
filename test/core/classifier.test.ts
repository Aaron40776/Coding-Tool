import { describe, expect, it } from 'vitest';
import { classify, parseClassification } from '../../src/core/classifier.js';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { route } from '../../src/core/router.js';
import { emptyUsage } from '../../src/core/types.js';

const result = (over: Partial<ClaudeResult>): ClaudeResult => ({
  isError: false, subtype: 'success', text: '', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.001 }, sessionId: 's', numTurns: 1, ...over,
});
const ctx = (run: RunClaudeFn) => ({ config: defaultConfig(), cwd: '.', run });

describe('parseClassification', () => {
  it('accepts a valid object', () => {
    expect(parseClassification({ complexity: 'small_edit', needsPlan: false, reason: 'one file' })).toEqual({
      complexity: 'small_edit', needsPlan: false, reason: 'one file',
    });
  });
  it('accepts fenced JSON text and prose-wrapped JSON', () => {
    expect(parseClassification('```json\n{"complexity":"multi_file","needsPlan":true,"reason":"r"}\n```')?.complexity).toBe('multi_file');
    expect(parseClassification('Sure! {"complexity":"trivial","needsPlan":false,"reason":"q"} hope that helps')?.complexity).toBe('trivial');
  });
  it('normalises needsPlan by complexity', () => {
    expect(parseClassification({ complexity: 'trivial', needsPlan: true, reason: 'x' })?.needsPlan).toBe(false);
    expect(parseClassification({ complexity: 'large_build', needsPlan: false, reason: 'x' })?.needsPlan).toBe(true);
    expect(parseClassification({ complexity: 'multi_file', reason: 'x' })?.needsPlan).toBe(false);
  });
  it('fills a missing reason', () => {
    expect(parseClassification({ complexity: 'small_edit' })?.reason).toMatch(/small_edit/);
  });
  it.each([[undefined], [null], [''], ['nonsense'], [{}], [{ complexity: 'huge' }], [{ complexity: 5 }], [[1, 2]]])('rejects %j', (bad) => {
    expect(parseClassification(bad)).toBeNull();
  });
});

describe('classify', () => {
  it('uses structured output and the classifier model, with no tools', async () => {
    let seen: Parameters<RunClaudeFn>[0] | undefined;
    const run: RunClaudeFn = async (o) => {
      seen = o;
      return result({ structured: { complexity: 'large_build', needsPlan: true, reason: 'whole app' } });
    };
    const { classification, usage } = await classify('make me a snake game', ctx(run));
    expect(classification.complexity).toBe('large_build');
    expect(usage.costUsd).toBe(0.001);
    expect(seen?.model).toBe('haiku');
    expect(seen?.tools).toEqual([]);
    expect(seen?.jsonSchema).toBeTruthy();
    expect(seen?.prompt).toContain('make me a snake game');
  });

  it('falls back to sonnet on malformed output', async () => {
    const { classification } = await classify('x', ctx(async () => result({ text: 'I cannot do that' })));
    expect(classification.fallback).toBe(true);
    expect(route({ classification, text: 'x' }, defaultConfig()).tier).toBe('sonnet');
  });

  it('falls back on a generic claude failure but keeps the cost at zero', async () => {
    const { classification, usage } = await classify('x', ctx(async () => { throw new SmartError('claude', 'boom'); }));
    expect(classification.fallback).toBe(true);
    expect(usage.costUsd).toBe(0);
  });

  it.each(['auth', 'cli_missing', 'cancelled'] as const)('propagates %s errors', async (kind) => {
    await expect(classify('x', ctx(async () => { throw new SmartError(kind, 'nope'); }))).rejects.toMatchObject({ kind });
  });

  it('forces sonnet for fallback even if multi_file is remapped', () => {
    const c = defaultConfig();
    c.routing.multi_file = 'opus';
    expect(route({ classification: { complexity: 'multi_file', needsPlan: false, reason: '', fallback: true }, text: 'x' }, c).tier).toBe('sonnet');
  });
});
