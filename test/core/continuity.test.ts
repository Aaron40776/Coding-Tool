import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string }

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
    const call: Call = { role, model: o.model, prompt: o.prompt, session: o.session, effort: o.effort };
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

describe('conversation continuity', () => {
  it('starts a Claude Code session on the first task and resumes the same one for follow-ups', async () => {
    const t = setup();
    await t.pipeline.runTask('create hello.txt');
    await t.pipeline.runTask('now make it uppercase');
    const [first, second] = t.executors();
    expect(first?.session?.resume).toBe(false);
    expect(second?.session?.resume).toBe(true);
    expect(second?.session?.id).toBe(first?.session?.id);
    expect(t.pipeline.chatTasks).toBe(2);
  });

  it('gives follow-ups the user\'s own words as the prompt', async () => {
    const t = setup();
    await t.pipeline.runTask('create hello.txt');
    await t.pipeline.runTask('now make it uppercase');
    expect(t.executors()[1]?.prompt).toBe('now make it uppercase');
  });

  it('gives the classifier and planner a memory of earlier tasks, but not on the first task', async () => {
    const t = setup({ complexities: ['small_edit', 'large_build'], executor: () => ({ isError: false, subtype: 'success', text: 'Created hello.txt', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }) });
    await t.pipeline.runTask('create hello.txt');
    expect(t.calls.find((c) => c.role === 'classifier')?.prompt).not.toContain('<conversation>');
    await t.pipeline.runTask('build a whole app on top of it', { autoApprove: true });
    const classifier2 = t.calls.filter((c) => c.role === 'classifier')[1]!;
    expect(classifier2.prompt).toContain('<conversation>');
    expect(classifier2.prompt).toContain('create hello.txt');
    expect(classifier2.prompt).toContain('Created hello.txt');
    expect(t.calls.find((c) => c.role === 'planner')?.prompt).toContain('create hello.txt');
  });

  it('keeps the same session across the steps of a plan', async () => {
    const t = setup({ complexities: ['large_build'] });
    await t.pipeline.runTask('build it', { autoApprove: true });
    const [a, b] = t.executors();
    expect(a?.session?.resume).toBe(false);
    expect(b?.session).toEqual({ id: a!.session!.id, resume: true });
    expect(b?.prompt).toContain('step 2 of 2');
  });

  it('with session.resume off it is stateless and injects the memory into the prompt instead', async () => {
    const t = setup({ config: (c) => { c.session.resume = false; } });
    await t.pipeline.runTask('create hello.txt');
    await t.pipeline.runTask('now make it uppercase');
    const [first, second] = t.executors();
    expect(first?.session).toBeUndefined();
    expect(second?.session).toBeUndefined();
    expect(first?.prompt).not.toContain('Context from earlier');
    expect(second?.prompt).toContain('Context from earlier in this conversation');
    expect(second?.prompt).toContain('create hello.txt');
  });

  it('recovers when the saved Claude Code session is gone: new session, memory in the prompt', async () => {
    let n = 0;
    const t = setup({
      executor: () => {
        n += 1;
        if (n === 2) throw new SmartError('claude', 'Claude Code reported an error: No conversation found with session ID: abc');
        return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    await t.pipeline.runTask('first');
    const s = await t.pipeline.runTask('second');
    expect(s.ok).toBe(true);
    const ex = t.executors();
    expect(ex).toHaveLength(3);
    expect(ex[1]?.session?.resume).toBe(true);
    expect(ex[2]?.session?.resume).toBe(false);
    expect(ex[2]?.session?.id).not.toBe(ex[1]?.session?.id);
    expect(ex[2]?.prompt).toContain('Context from earlier');
    expect(s.steps[0]?.attempts).toBe(1);
    expect(t.of('notice').some((e) => /not found/.test(e.message))).toBe(true);
  });

  it('newConversation() forgets everything', async () => {
    const t = setup();
    await t.pipeline.runTask('first');
    t.pipeline.newConversation();
    expect(t.pipeline.chatTasks).toBe(0);
    await t.pipeline.runTask('unrelated');
    const ex = t.executors();
    expect(ex[1]?.session?.resume).toBe(false);
    expect(ex[1]?.session?.id).not.toBe(ex[0]?.session?.id);
    expect(t.calls.filter((c) => c.role === 'classifier')[1]?.prompt).not.toContain('<conversation>');
    expect(t.of('conversation').at(-1)?.tasks).toBe(1);
  });

  it('refuses to start a new conversation mid-task', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ executor: async () => { await gate; return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; } });
    const p = t.pipeline.runTask('x');
    await new Promise((r) => setTimeout(r, 10));
    expect(() => t.pipeline.newConversation()).toThrow(/Cancel the running task/);
    release();
    await p;
  });

  it('does not remember dry runs or tasks that never executed', async () => {
    const t = setup();
    await t.pipeline.runTask('just planning', { dryRun: true });
    expect(t.pipeline.chatTasks).toBe(0);
  });

  it('remembers failed and cancelled tasks with their outcome', async () => {
    const t = setup({ executor: () => { throw new SmartError('claude', 'boom'); } });
    await t.pipeline.runTask('will fail');
    expect(t.pipeline.chatTasks).toBe(1);
    await t.pipeline.runTask('follow up');
    expect(t.calls.filter((c) => c.role === 'classifier')[1]?.prompt).toContain('will fail" → failed');
  });

  it('persists the conversation so `smart -c` can continue it', async () => {
    const store = new ConversationStore(join(mkdtempSync(join(tmpdir(), 'smart-cont-store-')), 'c.json'));
    const a = setup({ store });
    await a.pipeline.runTask('create hello.txt');
    const saved = store.load(a.cwd)!;
    expect(saved.tasks).toHaveLength(1);
    expect(saved.sessionId).toBeTruthy();

    const b = setup({ store, conversation: saved });
    expect(b.pipeline.chatTasks).toBe(1);
    await b.pipeline.runTask('now make it uppercase');
    expect(b.executors()[0]?.session).toEqual({ id: saved.sessionId, resume: true });
    expect(b.calls.find((c) => c.role === 'classifier')?.prompt).toContain('create hello.txt');
  });
});

describe('warm-cache routing across follow-ups', () => {
  it('does not downgrade a follow-up to a model with a cold cache while the session is warm', async () => {
    const t = setup({ complexities: ['small_edit', 'trivial'] });
    await t.pipeline.runTask('edit a file'); // sonnet
    t.advance(60_000);
    await t.pipeline.runTask('what does that do?'); // trivial → haiku, but haiku is cold
    expect(t.executors().map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
    expect(t.of('classified')[1]?.route.reason).toContain('kept sonnet');
  });

  it('downgrades normally once the cache has gone cold', async () => {
    const t = setup({ complexities: ['small_edit', 'trivial'] });
    await t.pipeline.runTask('edit a file');
    t.advance(10 * 60_000);
    await t.pipeline.runTask('what does that do?');
    expect(t.executors().map((c) => c.model)).toEqual(['sonnet', 'haiku']);
  });

  it('a forced model always wins', async () => {
    const t = setup({ complexities: ['small_edit', 'trivial'] });
    await t.pipeline.runTask('edit a file');
    t.pipeline.forceModel('haiku');
    await t.pipeline.runTask('what does that do?');
    expect(t.executors().map((c) => c.model)).toEqual(['sonnet', 'haiku']);
  });

  it('does not let one step\'s choice drag the rest of the same plan to a bigger model', async () => {
    const t = setup({ complexities: ['large_build'] });
    const p = t.pipeline.runTask('build it');
    while (!t.events.some((e) => e.type === 'plan:ready')) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 10));
    const plan = t.of('plan:ready')[0]!.plan;
    t.pipeline.approvePlan({ ...plan, steps: plan.steps.map((s, i) => (i === 0 ? { ...s, tier: 'opus' as const } : s)) });
    await p;
    expect(t.executors().map((c) => c.model)).toEqual(['opus', 'sonnet']);
  });
});

describe('effort and budget', () => {
  it('passes the configured --effort for the tier used', async () => {
    const t = setup({ config: (c) => { c.runner.effort = { sonnet: 'high' }; } });
    await t.pipeline.runTask('x');
    expect(t.executors()[0]?.effort).toBe('high'); // an explicit setting beats the automatic choice
    const auto = setup();
    await auto.pipeline.runTask('x');
    expect(auto.executors()[0]?.effort).toBe('medium'); // an ordinary small edit on Sonnet
    const off = setup({ config: (c) => { c.runner.autoEffort = false; } });
    await off.pipeline.runTask('x');
    expect(off.executors()[0]?.effort).toBeUndefined();
  });

  it('stops the task when its budget is reached and does not start the next step', async () => {
    const t = setup({ complexities: ['large_build'], cost: 0.5, config: (c) => { c.limits.maxBudgetUsdPerTask = 1; } });
    const s = await t.pipeline.runTask('build it', { autoApprove: true });
    // classify 0.5 + plan 0.5 = 1.0 already at the cap: nothing executes
    expect(t.executors()).toHaveLength(0);
    expect(s.ok).toBe(false);
    expect(t.of('notice').some((e) => /budget/i.test(e.message))).toBe(true);
    expect(t.of('step:failed')[0]?.error).toMatch(/budget/i);
  });
});
