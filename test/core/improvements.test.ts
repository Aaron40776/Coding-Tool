import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamParser, type ClaudeResult, type RunClaudeFn, type RunClaudeOptions } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage } from '../../src/core/types.js';
import type { ExecFn } from '../../src/core/verifier.js';

const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1, ...over });
type Role = 'classifier' | 'planner' | 'reviewer' | 'executor';
const roleOf = (o: RunClaudeOptions): Role => {
  const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : props && 'pass' in props ? 'reviewer' : 'executor';
};

function setup(opts: { classifier?: Record<string, unknown>; steps?: object[]; config?: (c: SmartConfig) => void; files?: Record<string, string>; executor?: (o: RunClaudeOptions, n: number) => ClaudeResult | void } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-imp-'));
  for (const [f, c] of Object.entries(opts.files ?? {})) writeFileSync(join(cwd, f), c);
  const calls: { role: Role; o: RunClaudeOptions }[] = [];
  let n = 0;
  const run: RunClaudeFn = async (o) => {
    const role = roleOf(o);
    calls.push({ role, o });
    if (role === 'classifier') return res({ structured: { complexity: 'small_edit', needsPlan: false, reason: 'r', ...opts.classifier } });
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: opts.steps ?? [{ title: 'A', instructions: 'do a', acceptance: ['x'] }, { title: 'B', instructions: 'do b', acceptance: ['y'] }] } });
    if (role === 'reviewer') return res({ structured: { pass: true, issues: [] } });
    n += 1;
    return opts.executor?.(o, n) ?? res({ text: 'did it' });
  };
  const ran: string[] = [];
  const exec: ExecFn = async (cmd) => {
    ran.push(cmd);
    return { code: 0, output: '' };
  };
  const config = defaultConfig();
  config.review.enabled = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, cwd, { run, exec, uid: 1000, listFiles: () => [] });
  return { pipeline, calls, ran, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('a forced model with planning off', () => {
  it('skips the classifier call: nothing it says would change what runs', async () => {
    const t = setup();
    t.pipeline.forceModel('opus');
    await t.pipeline.runTask('make the parser handle empty input', { noPlan: true });
    expect(t.calls.map((c) => c.role)).toEqual(['executor']);
    expect(t.calls[0]!.o.model).toBe('opus');
    expect(t.of('notice').some((n) => /classifier/i.test(n.message))).toBe(false); // no "classifier unavailable" warning
  });

  it('still classifies when only one of the two is set', async () => {
    const forced = setup();
    forced.pipeline.forceModel('opus');
    await forced.pipeline.runTask('make the parser handle empty input');
    expect(forced.calls[0]!.role).toBe('classifier');
    const noPlan = setup();
    await noPlan.pipeline.runTask('make the parser handle empty input', { noPlan: true });
    expect(noPlan.calls[0]!.role).toBe('classifier');
  });
});

describe('checks in a plan', () => {
  const pkg = JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } });
  const plan = { classifier: { complexity: 'large_build', needsPlan: true } };

  it('earlier steps get the quick checks, the last step the tests too', async () => {
    const t = setup({ ...plan, files: { 'package.json': pkg } });
    await t.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(t.ran).toEqual(['npm run lint', 'npm run lint', 'npm run test']);
    expect(t.of('notice').filter((n) => n.message.startsWith('Tests run after the last step'))).toHaveLength(1);
  });

  it('a single-step task runs everything', async () => {
    const t = setup({ files: { 'package.json': pkg } });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(t.ran).toEqual(['npm run lint', 'npm run test']);
  });

  it('verify.testEveryStep and your own verify.commands run everything after every step', async () => {
    const every = setup({ ...plan, files: { 'package.json': pkg }, config: (c) => { c.verify.testEveryStep = true; } });
    await every.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(every.ran).toEqual(['npm run lint', 'npm run test', 'npm run lint', 'npm run test']);
    const own = setup({ ...plan, config: (c) => { c.verify.commands = ['make test']; } });
    await own.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(own.ran).toEqual(['make test', 'make test']);
  });
});

describe('a Claude Code session that has grown big', () => {
  const bigStep = (size: number) => (o: RunClaudeOptions) => {
    o.onEvent?.({ kind: 'progress', inputTokens: 10, outputTokens: 10, cacheReadTokens: size, contextTokens: size });
    return undefined;
  };

  it('is replaced by a fresh one at the next task, which gets the conversation summary instead', async () => {
    const t = setup({ executor: bigStep(120_000), config: (c) => { c.session.maxContextTokens = 80_000; } });
    await t.pipeline.runTask('make the parser handle empty input');
    const first = t.calls.filter((c) => c.role === 'executor')[0]!.o;
    await t.pipeline.runTask('now make it handle null too');
    const second = t.calls.filter((c) => c.role === 'executor')[1]!.o;
    expect(second.session?.resume).toBe(false);
    expect(second.session?.id).not.toBe(first.session?.id);
    expect(second.prompt).toContain('make the parser handle empty input'); // the summary carries over
    expect(t.of('notice').some((n) => n.message.startsWith('Starting a fresh Claude Code session: the last one had grown to about 120k tokens'))).toBe(true);
  });

  it('is kept while under the limit, or when the limit is 0', async () => {
    const small = setup({ executor: bigStep(30_000) });
    await small.pipeline.runTask('make the parser handle empty input');
    await small.pipeline.runTask('now make it handle null too');
    expect(small.calls.filter((c) => c.role === 'executor')[1]!.o.session?.resume).toBe(true);
    const off = setup({ executor: bigStep(500_000), config: (c) => { c.session.maxContextTokens = 0; } });
    await off.pipeline.runTask('make the parser handle empty input');
    await off.pipeline.runTask('now make it handle null too');
    expect(off.calls.filter((c) => c.role === 'executor')[1]!.o.session?.resume).toBe(true);
  });
});

describe('StreamParser', () => {
  it('reports the size of the conversation as of the latest message', () => {
    const p = new StreamParser();
    const msg = (id: string, u: object) => JSON.stringify({ type: 'assistant', message: { id, content: [], usage: u } });
    p.push(`${msg('m1', { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 })}\n`);
    const ev = p.push(`${msg('m2', { input_tokens: 3, cache_read_input_tokens: 1250, cache_creation_input_tokens: 0, output_tokens: 40 })}\n`);
    expect(ev.find((e) => e.kind === 'progress')).toMatchObject({ contextTokens: 1293, cacheReadTokens: 2250 });
  });
});
