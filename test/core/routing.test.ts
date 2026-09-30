import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { parseClassification } from '../../src/core/classifier.js';
import { route } from '../../src/core/router.js';
import type { Checkpointer } from '../../src/core/checkpoint.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string; tools?: string[]; lean?: boolean }

function setup(opts: { complexities?: Complexity[]; config?: (c: SmartConfig) => void; executor?: (call: Call, n: number) => ClaudeResult | Promise<ClaudeResult>; store?: ConversationStore; conversation?: ReturnType<ConversationStore['load']>; cost?: number; classifier?: Record<string, unknown>; checkpoints?: Checkpointer } = {}) {
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
    run, uid: 1000, listFiles: () => [], checkpoints: opts.checkpoints, now: () => new Date(clock), conversationStore: opts.store, conversation: opts.conversation ?? undefined,
  });
  const executors = () => calls.filter((c) => c.role === 'executor');
  return { pipeline, calls, executors, events, cwd, advance: (ms: number) => (clock += ms), of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

const classification = (over: Record<string, unknown>) => parseClassification({ complexity: 'small_edit', needsPlan: false, reason: 'r', ...over })!;
const config = defaultConfig();

describe('classifier output: answer and difficulty', () => {
  it('keeps difficulty, and an answer only for a trivial task', () => {
    expect(classification({ difficulty: 'hard' }).difficulty).toBe('hard');
    expect(classification({ complexity: 'trivial', answer: '  It is 4.  ' }).answer).toBe('It is 4.');
    expect(classification({ complexity: 'small_edit', answer: 'not allowed' }).answer).toBeUndefined();
    expect(classification({ complexity: 'trivial', answer: '   ' }).answer).toBeUndefined();
    expect(classification({ difficulty: 'bogus' }).difficulty).toBeUndefined(); // a bad extra does not discard the classification
    expect(classification({ complexity: 'trivial', answer: 42 }).answer).toBeUndefined();
  });
});

describe('hard tasks go to Opus', () => {
  const at = (over: Record<string, unknown>, extra: Partial<Parameters<typeof route>[0]> = {}) => route({ classification: classification(over), text: 'x', ...extra }, config);

  it('routes a hard task straight to Opus, whatever its size', () => {
    expect(at({ difficulty: 'hard' }).tier).toBe('opus');
    expect(at({ difficulty: 'hard', complexity: 'multi_file' }).tier).toBe('opus');
    expect(at({ difficulty: 'hard' }).reason).toContain('hard');
  });

  it('never for a trivial one, for normal/easy ones, or against a forced model or a step tier', () => {
    expect(at({ difficulty: 'hard', complexity: 'trivial' }).tier).toBe('haiku');
    expect(at({ difficulty: 'normal' }).tier).toBe('sonnet');
    expect(at({ difficulty: 'easy' }).tier).toBe('sonnet');
    expect(at({ difficulty: 'hard' }, { override: 'haiku' }).tier).toBe('haiku');
    expect(at({ difficulty: 'hard' }, { step: { tier: 'sonnet' } }).tier).toBe('sonnet');
  });
});

describe('easy questions cost one Haiku call', () => {
  it('shows the classifier\'s answer and never starts a coding session', async () => {
    const t = setup({ classifier: { complexity: 'trivial', answer: 'A closure is a function that keeps access to its scope.' } });
    const res = await t.pipeline.runTask('what is a closure?');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.role).toBe('classifier');
    expect(res.ok).toBe(true);
    expect(t.pipeline.lastReplyText).toContain('closure');
    expect(t.of('step:output')[0]?.text).toContain('closure');
    expect(t.of('task:done')).toHaveLength(1);
    expect(t.pipeline.chatTasks).toBe(1);
  });

  it('a trivial question that needs the project has no answer and runs on Haiku with tools', async () => {
    const t = setup({ classifier: { complexity: 'trivial' } });
    await t.pipeline.runTask('what does util.js do?');
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'executor']);
    expect(t.executors()[0]).toMatchObject({ model: 'haiku' });
    expect(t.executors()[0]?.tools).toBeUndefined();
  });

  it('does not use the answer when the model is forced, in dry-run, or for a real task', async () => {
    const forced = setup({ classifier: { complexity: 'trivial', answer: 'x' } });
    forced.pipeline.forceModel('opus');
    await forced.pipeline.runTask('what is 2+2?');
    expect(forced.executors()).toHaveLength(1);
    expect(forced.executors()[0]?.model).toBe('opus');
    const dry = setup({ classifier: { complexity: 'trivial', answer: 'x' } });
    await dry.pipeline.runTask('what is 2+2?', { dryRun: true });
    expect(dry.executors()).toHaveLength(0);
    expect(dry.of('step:output')).toHaveLength(0);
    const edit = setup({ classifier: { complexity: 'small_edit', answer: 'ignored' } });
    await edit.pipeline.runTask('rename foo to bar');
    expect(edit.executors()).toHaveLength(1);
  });
});

describe('difficulty in the pipeline', () => {
  it('runs a hard single task on Opus at high effort', async () => {
    const t = setup({ classifier: { complexity: 'multi_file', difficulty: 'hard' } });
    await t.pipeline.runTask('fix the intermittent deadlock in the queue');
    expect(t.executors()[0]).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('does not send every step of a written plan to Opus: Opus plans, Sonnet executes', async () => {
    const t = setup({ complexities: ['large_build'], classifier: { difficulty: 'hard' } });
    await t.pipeline.runTask('build a compiler', { autoApprove: true });
    expect(t.calls.find((c) => c.role === 'planner')?.model).toBe('opus');
    expect(t.executors().map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
  });
});

describe('the git snapshot runs while the classifier thinks', () => {
  it('starts before the classifier returns and is ready before the first step', async () => {
    const order: string[] = [];
    const cp: Checkpointer = {
      available: true, root: '/', prefix: '',
      snapshot: async () => { order.push('snapshot-start'); await new Promise((r) => setTimeout(r, 20)); order.push('snapshot-done'); return 'tree1'; },
      changes: async () => null, diff: async () => null, restore: async () => null, dispose: () => undefined,
    };
    const t = setup({ checkpoints: cp, executor: () => { order.push('executor'); return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; } });
    t.events.length = 0;
    await t.pipeline.runTask('rename foo');
    expect(order[0]).toBe('snapshot-start');
    expect(order.indexOf('snapshot-done')).toBeLessThan(order.indexOf('executor'));
    expect(t.calls[0]?.role).toBe('classifier');
  });
});

describe('review fixes', () => {
  it('a greeting whose reply fails does not replace the unfinished task', async () => {
    const t = setup({
      complexities: ['large_build'],
      config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; },
      // step B of the plan fails, and so does the tool-less greeting reply
      executor: (call) => {
        if (call.prompt.includes('do b') || call.tools?.length === 0) throw new SmartError('claude', 'rate limited');
        return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.pipeline.pendingTask?.prompt).toBe('build it');
    const res = await t.pipeline.runTask('hey');
    expect(res.ok).toBe(false);
    expect(t.pipeline.pendingTask?.prompt).toBe('build it');
  });

  it('never uses the classifier\'s answer when the prompt references files the classifier did not see', async () => {
    const t = setup({ classifier: { complexity: 'trivial', answer: 'a guess' } });
    writeFileSync(join(t.cwd, 'a.txt'), 'hello');
    await t.pipeline.runTask('explain @a.txt', { autoApprove: true });
    expect(t.pipeline.lastReplyText).not.toBe('a guess');
    expect(t.executors()).toHaveLength(1);
  });

  it('small talk follows a forced model instead of silently using Haiku', async () => {
    const t = setup();
    t.pipeline.forceModel('opus');
    await t.pipeline.runTask('hey');
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'executor']);
    expect(t.executors()[0]?.model).toBe('opus');
  });

  it('records the classifier\'s own tier when it answers', async () => {
    const t = setup({ classifier: { complexity: 'trivial', answer: 'yes' }, config: (c) => { c.routing.classifier = 'sonnet'; } });
    const res = await t.pipeline.runTask('is water wet?');
    expect(res.steps[0]).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
  });

  it('waits for the background snapshot before finishing, so the next task cannot collide with it', async () => {
    let finished = false;
    const cp: Checkpointer = {
      available: true, root: '/', prefix: '',
      snapshot: async () => { await new Promise((r) => setTimeout(r, 40)); finished = true; return 't'; },
      changes: async () => null, diff: async () => null, restore: async () => null, dispose: () => undefined,
    };
    const t = setup({ checkpoints: cp, classifier: { complexity: 'trivial', answer: 'four' } });
    await t.pipeline.runTask('what is 2+2?'); // answered before the snapshot is needed
    expect(finished).toBe(true);
  });

  it('gives a hard step of a written plan the effort bump without sending it to Opus', async () => {
    const t = setup({ complexities: ['large_build'], classifier: { difficulty: 'hard' } });
    await t.pipeline.runTask('build a compiler', { autoApprove: true });
    expect(t.executors().map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
    expect(t.executors().map((c) => c.effort)).toEqual(['high', 'high']);
  });

  it('retries a failed lean call normally on any claude error, then stops using lean flags if that works', async () => {
    const seen: (boolean | undefined)[] = [];
    const config = defaultConfig();
    config.verify.auto = false;
    config.review.enabled = false;
    const ok = { isError: false, subtype: 'success', text: 'ok', usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    const run: RunClaudeFn = async (o) => {
      seen.push(o.lean);
      if (o.lean) throw new SmartError('claude', 'Claude Code failed: could not reach the configured endpoint');
      const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      return props && 'complexity' in props ? { ...ok, structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' } } : { ...ok, structured: undefined };
    };
    const p = new Pipeline(config, new EventBus(), mkdtempSync(join(tmpdir(), 'smart-lean2-')), { run, uid: 1000, listFiles: () => [] });
    const res = await p.runTask('create a.txt');
    expect(res.classification?.fallback).toBeUndefined(); // classification came from the retried call, not the fallback
    expect(seen.slice(0, 2)).toEqual([true, undefined]);
    expect(seen.slice(2).every((v) => !v)).toBe(true);
  });
});

describe('finishing a task', () => {
  it('saves the cost record before the frontend is told the task failed or was cancelled', async () => {
    const order: string[] = [];
    const tracker = { append: () => { order.push('tracker'); return null; }, load: () => [] } as unknown as import('../../src/core/store/tracker.js').Tracker;
    const t = setup({ executor: () => { throw new SmartError('auth', 'not logged in'); } });
    // rebuild a pipeline that has a tracker, sharing the scripted claude
    const { pipeline, events } = (() => {
      const bus = new EventBus();
      const evs: SmartEvent[] = [];
      bus.subscribe((e) => { evs.push(e); if (e.type === 'error' || e.type === 'task:cancelled' || e.type === 'task:done') order.push(e.type); });
      const run: RunClaudeFn = async (o) => {
        const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        if (props && 'complexity' in props) return { isError: false, subtype: 'success', text: '', structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' }, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1 };
        throw new SmartError('auth', 'not logged in');
      };
      return { pipeline: new Pipeline(defaultConfig(), bus, t.cwd, { run, tracker, uid: 1000, listFiles: () => [] }), events: evs };
    })();
    await pipeline.runTask('rename foo');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(order).toEqual(['tracker', 'error']);
  });

  it('lets a frontend start the next task from the terminal event without "already running"', async () => {
    const t = setup();
    let next: Promise<unknown> | null = null;
    let started = false;
    t.pipeline.bus.subscribe((e) => {
      if (e.type === 'task:done' && !started) {
        started = true;
        next = t.pipeline.runTask('hey');
      }
    });
    await t.pipeline.runTask('rename foo');
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('settle() resolves at once when idle and waits for a running task to finish saving', async () => {
    const t = setup({ executor: async () => { await new Promise((r) => setTimeout(r, 30)); return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; } });
    await t.pipeline.settle(50);
    const running = t.pipeline.runTask('rename foo');
    await new Promise((r) => setTimeout(r, 5));
    t.pipeline.cancel();
    await t.pipeline.settle(2000);
    expect(t.pipeline.isRunning).toBe(false);
    await running;
  });
});

describe('spend of failed calls', () => {
  it('counts what a call that ended in an error cost, so totals and the budget cap stay honest', async () => {
    const failing = Object.assign(new SmartError('claude', 'error_max_turns'), { usage: { ...emptyUsage(), costUsd: 0.75, outputTokens: 900 } });
    const t = setup({
      config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; },
      executor: () => { throw failing; },
    });
    const res = await t.pipeline.runTask('rename foo');
    expect(res.ok).toBe(false);
    expect(res.totals.costUsd).toBeGreaterThanOrEqual(0.75);
    expect(res.totals.outputTokens).toBeGreaterThanOrEqual(900);
  });
});

