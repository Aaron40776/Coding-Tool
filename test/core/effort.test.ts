import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { pickEffort, planEffort } from '../../src/core/effort.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

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

describe('pickEffort', () => {
  it('is cheap for easy work and grows with complexity', () => {
    const at = (complexity: Complexity, difficulty?: 'easy' | 'normal' | 'hard') => pickEffort({ tier: 'sonnet', complexity, difficulty, failuresOnTier: 0, config: cfg() });
    expect(at('trivial')).toBe('low');
    expect(at('small_edit', 'easy')).toBe('low'); // only what the classifier calls easy runs at low
    expect(at('small_edit')).toBe('medium');
    expect(at('small_edit', 'normal')).toBe('medium');
    expect(at('multi_file')).toBe('medium');
    expect(at('multi_file', 'easy')).toBe('medium'); // multi-file work keeps a medium level even when it is straightforward
    expect(at('large_build', 'easy')).toBe('medium');
    expect(at('small_edit', 'hard')).toBe('high');
  });

  it('goes one level up on Opus (except for trivial work) and after a failed attempt, never above high', () => {
    expect(pickEffort({ tier: 'opus', complexity: 'small_edit', difficulty: 'easy', failuresOnTier: 0, config: cfg() })).toBe('medium');
    expect(pickEffort({ tier: 'opus', complexity: 'trivial', failuresOnTier: 0, config: cfg() })).toBe('low');
    expect(pickEffort({ tier: 'sonnet', complexity: 'small_edit', difficulty: 'easy', failuresOnTier: 1, config: cfg() })).toBe('medium');
    expect(pickEffort({ tier: 'opus', complexity: 'large_build', failuresOnTier: 3, config: cfg() })).toBe('high');
  });

  it('sets nothing for Haiku, and nothing when autoEffort is off', () => {
    expect(pickEffort({ tier: 'haiku', complexity: 'large_build', failuresOnTier: 2, config: cfg() })).toBeUndefined();
    expect(pickEffort({ tier: 'sonnet', complexity: 'large_build', failuresOnTier: 0, config: cfg((c) => { c.runner.autoEffort = false; }) })).toBeUndefined();
  });

  it('lets an explicit runner.effort win', () => {
    expect(pickEffort({ tier: 'sonnet', complexity: 'trivial', failuresOnTier: 0, config: cfg((c) => { c.runner.effort.sonnet = 'max'; }) })).toBe('max');
    expect(pickEffort({ tier: 'sonnet', complexity: 'trivial', failuresOnTier: 0, config: cfg((c) => { c.runner.autoEffort = false; c.runner.effort.sonnet = 'high'; }) })).toBe('high');
  });

  it('plans large builds at high effort and everything else at medium', () => {
    expect(planEffort('large_build', cfg())).toBe('high');
    expect(planEffort('multi_file', cfg())).toBe('medium');
    expect(planEffort('large_build', cfg((c) => { c.runner.autoEffort = false; }))).toBeUndefined();
  });
});

describe('effort in the pipeline', () => {
  it('sends effort matching the task to the planner and to each coding step', async () => {
    const t = setup({ complexities: ['large_build'] });
    await t.pipeline.runTask('build a whole app', { autoApprove: true });
    expect(t.calls.find((c) => c.role === 'planner')?.effort).toBe('high');
    for (const c of t.executors()) expect(c.effort).toBe('medium');
    expect(t.of('step:start')[0]?.route.reason).toContain('effort medium');
  });

  it('uses low effort for a small edit and none when the task is forced to Haiku', async () => {
    const small = setup({ complexities: ['small_edit'], classifier: { difficulty: 'easy' } });
    await small.pipeline.runTask('rename a variable');
    expect(small.executors()[0]?.effort).toBe('low');
    const forced = setup({ complexities: ['small_edit'] });
    forced.pipeline.forceModel('haiku');
    await forced.pipeline.runTask('rename a variable');
    expect(forced.executors()[0]?.effort).toBeUndefined();
  });

  it('thinks harder on a retry before the model changes', async () => {
    const t = setup({
      complexities: ['small_edit'], classifier: { difficulty: 'easy' },
      executor: (_c, n) => { if (n === 1) throw new SmartError('claude', 'boom'); return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; },
    });
    await t.pipeline.runTask('rename a variable');
    const [first, second] = t.executors();
    expect(first?.model).toBe(second?.model);
    expect(first?.effort).toBe('low');
    expect(second?.effort).toBe('medium');
  });
});
