import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../src/core/claude.js';
import { SmartError } from '../src/core/errors.js';
import { runPrint, type PrintOptions } from '../src/print.js';
import { emptyUsage } from '../src/core/types.js';
import { makeApp } from './ui/helpers.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: { write: (s: string) => out.push(s) }, err: { write: (s: string) => err.push(s) } } };
}
const text = (out: string[]) => out.join('');
const base: PrintOptions = { format: 'text', verbose: false };
const ok = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ isError: false, subtype: 'success', text: 'All done here.', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.05 }, sessionId: 's', numTurns: 1, ...over });

describe('runPrint', () => {
  it('prints the final reply to stdout, progress to stderr, and returns 0', async () => {
    const ctx = makeApp({ complexity: 'small_edit', executor: async () => ok() });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'fix it', base, cap.io);
    expect(code).toBe(0);
    expect(text(cap.out)).toBe('All done here.\n');
    const err = text(cap.err);
    expect(err).toContain('smart: classified small_edit');
    expect(err).toContain('[1/1] Complete the task (sonnet)');
    expect(err).toMatch(/smart: done in \d+s · \$0\.\d+/);
  });

  it('auto-approves multi-step plans and lists the steps', async () => {
    const ctx = makeApp({ complexity: 'large_build', executor: async () => ok() });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'build it', base, cap.io);
    expect(code).toBe(0);
    const err = text(cap.err);
    expect(err).toContain('plan: 2 steps');
    expect(err).toContain('[1/2] First (sonnet)');
    expect(err).toContain('[2/2] Second (sonnet)');
  });

  it('dry run prints the routing table to stdout and never calls the coder', async () => {
    let called = 0;
    const ctx = makeApp({ complexity: 'large_build', executor: async () => { called += 1; return ok(); } });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'build it', { ...base, dryRun: true }, cap.io);
    expect(code).toBe(0);
    expect(called).toBe(0);
    expect(text(cap.out)).toContain('large_build → sonnet');
    expect(text(cap.out)).toMatch(/- First \[sonnet\] sonnet · \w+ · rated \d\.\d\d/); // the rater's reason
  });

  it('emits one JSON document with steps, models, usage and the reply', async () => {
    const ctx = makeApp({ complexity: 'large_build', executor: async () => ok() });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'build it', { ...base, format: 'json' }, cap.io);
    const j = JSON.parse(text(cap.out));
    expect(code).toBe(0);
    expect(j).toMatchObject({ ok: true, cancelled: false, dryRun: false, reply: 'All done here.', error: null });
    expect(j.classification.complexity).toBe('large_build');
    expect(j.steps.map((s: { outcome: string; model: string }) => `${s.model}:${s.outcome}`)).toEqual(['sonnet:done', 'sonnet:done']);
    expect(j.usage.costUsd).toBeGreaterThan(0);
  });

  it('returns 1 and reports the error with its hint when the task fails', async () => {
    const ctx = makeApp({ complexity: 'small_edit', executor: async () => { throw new SmartError('auth', 'not logged in', 'Run `claude` to log in'); } });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'x', base, cap.io);
    expect(code).toBe(1);
    expect(text(cap.err)).toContain('error: not logged in Run `claude` to log in');
    expect(text(cap.out)).toBe('');
    expect(text(cap.err)).toContain('failed in');
  });

  it('returns 130 when cancelled', async () => {
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const executor: RunClaudeFn = (o) => new Promise((_, reject) => { started(); o.signal?.addEventListener('abort', () => reject(new SmartError('cancelled', 'Cancelled.'))); });
    const ctx = makeApp({ complexity: 'small_edit', executor });
    const cap = io();
    const p = runPrint(ctx.pipeline, ctx.bus, 'x', base, cap.io);
    await go;
    ctx.pipeline.cancel();
    expect(await p).toBe(130);
    expect(text(cap.err)).toContain('cancelled in');
  });

  it('verbose mode also streams tool calls to stderr, quiet mode does not', async () => {
    const executor: RunClaudeFn = async (o) => {
      o.onEvent?.({ kind: 'tool', name: 'Write', summary: 'Write src/a.js' });
      return ok();
    };
    const loudCtx = makeApp({ complexity: 'small_edit', executor });
    const loud = io();
    await runPrint(loudCtx.pipeline, loudCtx.bus, 'x', { ...base, verbose: true }, loud.io);
    expect(text(loud.err)).toContain('⏺ Write src/a.js');
    const quietCtx = makeApp({ complexity: 'small_edit', executor });
    const quiet = io();
    await runPrint(quietCtx.pipeline, quietCtx.bus, 'x', base, quiet.io);
    expect(text(quiet.err)).not.toContain('⏺ Write');
  });

  it('json output names the failed step in `error`', async () => {
    const ctx = makeApp({ complexity: 'small_edit', config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; }, executor: async () => { throw new SmartError('claude', 'boom happened'); } });
    const cap = io();
    const code = await runPrint(ctx.pipeline, ctx.bus, 'fix it', { ...base, format: 'json' }, cap.io);
    const j = JSON.parse(text(cap.out));
    expect(code).toBe(1);
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/failed: .*boom happened/);
  });

  it('a resumed run reports the steps finished earlier as done, not pending', async () => {
    let n = 0;
    const ctx = makeApp({ complexity: 'large_build', config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; }, executor: async () => { n += 1; if (n === 2) throw new SmartError('claude', 'boom'); return ok(); } });
    const first = io();
    expect(await runPrint(ctx.pipeline, ctx.bus, 'build it', { ...base, format: 'json' }, first.io)).toBe(1);
    const second = io();
    expect(await runPrint(ctx.pipeline, ctx.bus, '', { ...base, format: 'json', resume: true }, second.io)).toBe(0);
    const j = JSON.parse(text(second.out));
    expect(j.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'done']);
  });
});
