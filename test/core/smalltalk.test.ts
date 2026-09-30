import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { isSmallTalk } from '../../src/core/smalltalk.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string; tools?: string[]; lean?: boolean }

function setup(opts: { complexities?: Complexity[]; config?: (c: SmartConfig) => void; executor?: (call: Call, n: number) => ClaudeResult | Promise<ClaudeResult>; store?: ConversationStore; conversation?: ReturnType<ConversationStore['load']>; cost?: number } = {}) {
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
    if (role === 'classifier') return res({ structured: { complexity: queue.shift() ?? 'small_edit', needsPlan: false, reason: 'r' } });
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

describe('isSmallTalk', () => {
  it.each(['hey', 'Hey!', 'hello', 'hi there', 'thanks', 'thank you', 'thanks a lot!', 'ok', 'good morning', 'hallo', "what's up", 'how are you', 'hey smart'])('treats %j as small talk', (t) => {
    expect(isSmallTalk(t)).toBe(true);
  });

  it.each(['', 'fix the bug', 'hey fix the bug', 'hey can you add tests', 'ok now add a button', 'thanks, now make it red', 'hi @src/a.ts', 'hello world program in c', 'ok 5', 'hey\nbuild a game', 'x'.repeat(50), 'help', 'yes', 'no', 'continue'])('does not treat %j as small talk', (t) => {
    expect(isSmallTalk(t)).toBe(false);
  });
});

describe('small talk fast path', () => {
  it('answers a greeting with ONE tool-less lean Haiku call: no classifier, no session, no plan', async () => {
    const t = setup({ executor: () => ({ isError: false, subtype: 'success', text: 'Hey! What are you working on?', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.002 }, sessionId: 's', numTurns: 1 }) });
    const res = await t.pipeline.runTask('hey');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ role: 'executor', model: 'haiku', tools: [] });
    expect(t.calls[0]?.session).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(t.pipeline.lastReplyText).toContain('What are you working on');
    expect(t.of('step:output')[0]?.text).toContain('Hey!');
    expect(t.of('task:done')).toHaveLength(1);
    expect(res.totals.costUsd).toBeCloseTo(0.002);
  });

  it('is remembered in the conversation but does not start a Claude Code session', async () => {
    const t = setup();
    await t.pipeline.runTask('hey');
    expect(t.pipeline.chatTasks).toBe(1);
    await t.pipeline.runTask('create a.txt');
    const coder = t.executors().find((c) => c.session);
    expect(coder?.session?.resume).toBe(false); // the first real task still starts the session
  });

  it('does not treat a real task that starts with a greeting as small talk', async () => {
    const t = setup();
    await t.pipeline.runTask('hey can you create a.txt');
    expect(t.calls[0]?.role).toBe('classifier');
  });

  it('keeps an unfinished task resumable across a greeting', async () => {
    const t = setup({ complexities: ['large_build'], executor: (call, n) => { if (n === 2) throw new SmartError('claude', 'boom'); return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; }, config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; } });
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.pipeline.pendingTask).not.toBeNull();
    await t.pipeline.runTask('thanks');
    expect(t.pipeline.pendingTask).not.toBeNull();
  });

  it('classifies normally in dry-run', async () => {
    const t = setup();
    await t.pipeline.runTask('hey', { dryRun: true });
    expect(t.calls[0]?.role).toBe('classifier');
  });
});

describe('lean calls', () => {
  it('passes lean only to tool-less calls (classify, plan), never to the coder', async () => {
    const t = setup({ complexities: ['large_build'] });
    await t.pipeline.runTask('build a whole app', { autoApprove: true });
    for (const c of t.calls) expect(Boolean(c.lean), c.role).toBe(c.role !== 'executor');
  });

  it('can be turned off in config', async () => {
    const t = setup({ config: (c) => { c.runner.leanCalls = false; } });
    await t.pipeline.runTask('create a.txt');
    expect(t.calls.some((c) => c.lean)).toBe(false);
  });

  it('retries a lean call without lean flags on an auth error, then stops using them', async () => {
    let n = 0;
    const seen: (boolean | undefined)[] = [];
    const bus = new EventBus();
    const cwd = mkdtempSync(join(tmpdir(), 'smart-lean-'));
    const config = defaultConfig();
    config.verify.auto = false;
    config.review.enabled = false;
    const run: RunClaudeFn = async (o) => {
      seen.push(o.lean);
      n += 1;
      if (o.lean) throw new SmartError('auth', 'not logged in');
      const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      const ok = { isError: false, subtype: 'success', text: 'ok', usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      return props && 'complexity' in props ? { ...ok, structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' } } : { ...ok, structured: undefined };
    };
    const p = new Pipeline(config, bus, cwd, { run, uid: 1000, listFiles: () => [] });
    const res = await p.runTask('create a.txt');
    expect(res.ok).toBe(true);
    expect(seen.slice(0, 2)).toEqual([true, undefined]); // lean failed with auth, retried without
    expect(seen.slice(2).every((v) => !v)).toBe(true); // and no further lean calls this session
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
