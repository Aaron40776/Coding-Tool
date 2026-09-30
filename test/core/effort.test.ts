import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { effortFor, planEffort } from '../../src/core/effort.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity, type RouteDecision } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string; tools?: string[]; lean?: boolean }

function setup(opts: { complexities?: Complexity[]; config?: (c: SmartConfig) => void; executor?: (call: Call, n: number) => ClaudeResult | Promise<ClaudeResult>; store?: ConversationStore; conversation?: ReturnType<ConversationStore['load']>; cost?: number; classifier?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000_000_000;
  const queue = [...(opts.complexities ?? [])];
  let executorCalls = 0;
  const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
    isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: opts.cost ?? 0.01, outputTokens: 50 }, sessionId: 's', numTurns: 1, ...over,
  });
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : 'executor';
    const call: Call = { role, model: o.model, prompt: o.prompt, session: o.session, effort: o.effort, tools: o.tools, lean: o.lean };
    calls.push(call);
    if (role === 'classifier') return res({ structured: { complexity: queue.shift() ?? 'small_edit', needsPlan: false, reason: 'r', ...opts.classifier } });
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: [{ title: 'A', instructions: 'do a', acceptance: [] }, { title: 'B', instructions: 'do b', acceptance: [] }] } });
    executorCalls += 1;
    if (opts.executor) return opts.executor(call, executorCalls);
    return res({ text: `reply ${executorCalls}` });
  };
  const config = defaultConfig();
  config.verify.auto = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cwd = mkdtempSync(join(tmpdir(), 'smart-cont-'));
  const pipeline = new Pipeline(config, bus, cwd, {
    run, uid: 1000, listFiles: () => [], now: () => new Date(clock), conversationStore: opts.store, conversation: opts.conversation ?? undefined,
  });
  const executors = () => calls.filter((c) => c.role === 'executor');
  return { pipeline, calls, executors, events, cwd, advance: (ms: number) => (clock += ms), of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

const cfg = (over: (c: SmartConfig) => void = () => undefined): SmartConfig => {
  const c = defaultConfig();
  over(c);
  return c;
};
const dec = (over: Partial<RouteDecision>): RouteDecision => ({ tier: 'sonnet', model: 'sonnet', reason: 'r', ratedTier: 'sonnet', effort: 'medium', score: 0.3, ...over });

describe('effortFor', () => {
  it('uses the effort the rater chose with the model', () => {
    expect(effortFor({ decision: dec({ effort: 'low' }), tier: 'sonnet', failuresOnTier: 0, escalated: false, config: cfg() })).toBe('low');
    expect(effortFor({ decision: dec({ tier: 'opus', ratedTier: 'opus', effort: 'high', score: 0.85 }), tier: 'opus', failuresOnTier: 0, escalated: false, config: cfg() })).toBe('high');
  });

  it('goes one level up after a failed attempt on the same model, capped at Sonnet high / Opus xhigh', () => {
    const at = (tier: 'sonnet' | 'opus', effort: RouteDecision['effort']) => effortFor({ decision: dec({ tier, ratedTier: tier, effort }), tier, failuresOnTier: 1, escalated: false, config: cfg() });
    expect(at('sonnet', 'low')).toBe('medium');
    expect(at('sonnet', 'medium')).toBe('high');
    expect(at('sonnet', 'high')).toBe('high');
    expect(at('opus', 'high')).toBe('xhigh');
    expect(at('opus', 'xhigh')).toBe('xhigh');
  });

  it('after escalating to a stronger model, uses that model\'s effort for the score, one level up', () => {
    // rated for sonnet at 0.3; the step failed and moved to opus: opus medium is its floor, +1 for the failure
    expect(effortFor({ decision: dec({ score: 0.3 }), tier: 'opus', failuresOnTier: 0, escalated: true, config: cfg() })).toBe('high');
    expect(effortFor({ decision: dec({ score: 0.7 }), tier: 'opus', failuresOnTier: 0, escalated: true, config: cfg() })).toBe('high');
  });

  it('recomputes the effort when the warm-cache or limit rules changed the model', () => {
    // rated opus/high at 0.85, then the usage limit downshifted it to sonnet: sonnet at 0.85 is high
    expect(effortFor({ decision: dec({ tier: 'sonnet', ratedTier: 'opus', effort: 'high', score: 0.85 }), tier: 'sonnet', failuresOnTier: 0, escalated: false, config: cfg() })).toBe('high');
    expect(effortFor({ decision: dec({ tier: 'sonnet', ratedTier: 'opus', effort: 'medium', score: 0.1 }), tier: 'sonnet', failuresOnTier: 0, escalated: false, config: cfg() })).toBe('low');
  });

  it('sets nothing for Haiku or when autoEffort is off, and a pinned level always wins', () => {
    expect(effortFor({ decision: dec({ tier: 'haiku', ratedTier: 'haiku', effort: undefined }), tier: 'haiku', failuresOnTier: 2, escalated: false, config: cfg() })).toBeUndefined();
    expect(effortFor({ decision: dec({}), tier: 'sonnet', failuresOnTier: 0, escalated: false, config: cfg((c) => { c.runner.autoEffort = false; }) })).toBeUndefined();
    expect(effortFor({ decision: dec({}), tier: 'sonnet', failuresOnTier: 0, escalated: false, config: cfg((c) => { c.runner.effort.sonnet = 'max'; }) })).toBe('max');
    expect(effortFor({ decision: dec({}), tier: 'sonnet', failuresOnTier: 1, escalated: true, config: cfg((c) => { c.runner.autoEffort = false; c.runner.effort.sonnet = 'high'; }) })).toBe('high');
  });

  it('plans big or hard-looking work at high effort and everything else at medium', () => {
    expect(planEffort('large_build', cfg())).toBe('high');
    expect(planEffort('multi_file', cfg(), 0.7)).toBe('high');
    expect(planEffort('multi_file', cfg(), 0.4)).toBe('medium');
    expect(planEffort('large_build', cfg((c) => { c.runner.autoEffort = false; }))).toBeUndefined();
  });
});

describe('effort in the pipeline', () => {
  it('sends the rated effort to each coding step, and a higher one to the planner for a big build', async () => {
    const t = setup({ complexities: ['large_build'] });
    await t.pipeline.runTask('build a whole app', { autoApprove: true });
    expect(t.calls.find((c) => c.role === 'planner')?.effort).toBe('high');
    for (const c of t.executors()) expect(['low', 'medium', 'high']).toContain(c.effort);
    expect(t.of('step:start')[0]?.route.reason).toMatch(/rated \d\.\d\d/);
  });

  it('gives Haiku no effort and lowers effort for an easy edit', async () => {
    const forced = setup({ complexities: ['small_edit'] });
    forced.pipeline.forceModel('haiku');
    await forced.pipeline.runTask('rename a variable');
    expect(forced.executors()[0]?.effort).toBeUndefined();
    const easy = setup({ complexities: ['small_edit'], classifier: { difficulty: 'easy' } });
    await easy.pipeline.runTask('fix the typo in the readme');
    expect(easy.executors()[0]?.effort).toBe('low');
  });

  it('thinks harder on a retry before the model changes', async () => {
    const t = setup({
      complexities: ['small_edit'], classifier: { difficulty: 'easy' },
      executor: (_c, n) => { if (n === 1) throw new SmartError('claude', 'boom'); return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; },
    });
    await t.pipeline.runTask('fix the typo in the readme');
    const [first, second] = t.executors();
    expect(first?.model).toBe(second?.model);
    expect(first?.effort).toBe('low');
    expect(second?.effort).toBe('medium');
  });
});
