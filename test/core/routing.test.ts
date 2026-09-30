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
import { plannerTier, route, routeRole } from '../../src/core/router.js';
import type { Checkpointer } from '../../src/core/checkpoint.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string; tools?: string[]; lean?: boolean }

function setup(opts: { complexities?: Complexity[]; config?: (c: SmartConfig) => void; executor?: (call: Call, n: number) => ClaudeResult | Promise<ClaudeResult>; store?: ConversationStore; conversation?: ReturnType<ConversationStore['load']>; cost?: number; classifier?: Record<string, unknown>; checkpoints?: Checkpointer; plannerSteps?: object[] } = {}) {
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
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: opts.plannerSteps ?? [{ title: 'A', instructions: 'do a', acceptance: [] }, { title: 'B', instructions: 'do b', acceptance: [] }] } });
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

describe('the rater decides the model', () => {
  const at = (text: string, over: Record<string, unknown>, extra: Partial<Parameters<typeof route>[0]> = {}) => route({ classification: classification(over), text, ...extra }, config);

  it('sends a hard-looking, hard-rated task to Opus and says why', () => {
    const d = at('the workers stall intermittently under load, find the root cause of this concurrency bug in worker.js', { difficulty: 'hard' });
    expect(d.tier).toBe('opus');
    expect(d.reason).toMatch(/opus · \w+ · rated \d\.\d\d · \d+% sure \(.*concurrency/);
    expect(d.score).toBeGreaterThan(0.6);
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('keeps a routine edit on Sonnet at low effort, and a plain question on Haiku', () => {
    expect(at('fix the typo in the README', { difficulty: 'easy' })).toMatchObject({ tier: 'sonnet', effort: 'low' });
    expect(at('what is a closure?', { complexity: 'trivial', difficulty: 'easy' }).tier).toBe('haiku');
  });

  it('a hard classification alone is not enough when the text shows nothing hard, but it does raise the score', () => {
    const plain = at('do the thing in the module', { difficulty: 'normal' });
    const flagged = at('do the thing in the module', { difficulty: 'hard' });
    expect(flagged.score!).toBeGreaterThan(plain.score!);
  });

  it('a forced model, a per-step tier and a keyword rule still decide the model; effort follows the score', () => {
    expect(at('fix the intermittent deadlock', { difficulty: 'hard' }, { override: 'haiku' }).tier).toBe('haiku');
    const stepPick = at('fix the typo', { difficulty: 'easy' }, { step: { tier: 'opus' } });
    expect(stepPick.tier).toBe('opus');
    expect(stepPick.effort).toBe('medium'); // Opus starts at medium even for an easy step
    expect(at('something about architecture', { difficulty: 'normal' }).tier).toBe('opus'); // built-in keyword rule
  });

  it('unusable classifier output no longer means "always Sonnet": the local signals still rate the work', () => {
    const fallback = { ...classification({}), fallback: true };
    const deadlock = route({ classification: fallback, text: 'the workers stall intermittently under load, find the root cause of this concurrency bug' }, config);
    expect(deadlock.tier).toBe('opus');
    expect(deadlock.source).toBe('fallback');
    expect(deadlock.reason).toContain('classifier output unusable');
    expect(route({ classification: fallback, text: 'fix the typo in the readme' }, config).tier).toBe('sonnet'); // Sonnet is the floor
  });

  it('the per-complexity tier in the config is a floor the rater never goes under', () => {
    const c = defaultConfig();
    c.routing.multi_file = 'opus';
    expect(route({ classification: classification({ complexity: 'multi_file' }), text: 'fix the typo in the readme' }, c).tier).toBe('opus');
    c.routing.small_edit = 'haiku';
    // with a Haiku floor an easy, low-scoring edit may go to Haiku, but a harder one is still raised
    expect(route({ classification: classification({ complexity: 'small_edit', difficulty: 'easy' }), text: 'fix the typo in the readme' }, c).tier).toBe('haiku');
    expect(route({ classification: classification({ complexity: 'small_edit', difficulty: 'normal' }), text: 'add input validation and error messages to the signup form and the profile form' }, c).tier).toBe('sonnet');
  });

  it('routing.optimize moves the same work to a cheaper or a stronger rung', () => {
    const text = 'add a search box to the todo list and persist todos in localStorage';
    const rung = (optimize: 'cost' | 'balanced' | 'quality') => {
      const c = defaultConfig();
      c.routing.optimize = optimize;
      return route({ classification: classification({ complexity: 'multi_file' }), text }, c);
    };
    const order = ['low', 'medium', 'high'];
    expect(order.indexOf(rung('cost').effort!)).toBeLessThanOrEqual(order.indexOf(rung('balanced').effort!));
    expect(order.indexOf(rung('quality').effort!)).toBeGreaterThanOrEqual(order.indexOf(rung('balanced').effort!));
    expect(rung('cost').score).toBe(rung('balanced').score); // the score is the same, only the thresholds move
  });

  it('a step of a written plan is rated on its own text and the planner\'s difficulty', () => {
    const hardStep = route({ classification: classification({ complexity: 'large_build' }), text: 'Lock-free queue\nimplement the queue so workers never deadlock or race', step: { difficulty: 'hard' } }, config);
    const easyStep = route({ classification: classification({ complexity: 'large_build' }), text: 'Scaffold\nset up the folders and boilerplate', step: { difficulty: 'easy' } }, config);
    expect(hardStep.tier).toBe('opus');
    expect(easyStep).toMatchObject({ tier: 'sonnet', effort: 'low' });
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
    expect(t.executors()[0]).toMatchObject({ model: 'opus' });
    expect(['medium', 'high']).toContain(t.executors()[0]?.effort);
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
    await t.pipeline.runTask('make the parser handle empty input');
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

  it('rates each step of a written plan by the planner\'s difficulty: the easy one on Sonnet low, the hard one on Opus', async () => {
    const t = setup({
      complexities: ['large_build'],
      plannerSteps: [
        { title: 'Scaffold', instructions: 'set up the folders and boilerplate', acceptance: [], difficulty: 'easy' },
        { title: 'Lock-free queue', instructions: 'implement the queue so workers never deadlock or race', acceptance: [], difficulty: 'hard' },
      ],
    });
    await t.pipeline.runTask('build a job runner', { autoApprove: true });
    const [scaffold, queue] = t.executors();
    expect(scaffold).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(queue?.model).toBe('opus');
    expect(['medium', 'high']).toContain(queue?.effort);
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
    await pipeline.runTask('make the parser handle empty input');
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

describe('who plans', () => {
  it('Opus plans big builds and hard tasks; Sonnet plans mid-size ones', () => {
    const c = defaultConfig();
    expect(plannerTier({ complexity: 'large_build' }, c)).toBe('opus');
    expect(plannerTier({ complexity: 'multi_file', difficulty: 'hard' }, c)).toBe('opus');
    expect(plannerTier({ complexity: 'multi_file' }, c)).toBe('sonnet');
    expect(plannerTier({ complexity: 'small_edit', difficulty: 'easy' }, c)).toBe('sonnet');
    expect(plannerTier(undefined, c)).toBe('opus'); // no information: play safe
    expect(routeRole('planner', c, 'haiku').tier).toBe('haiku'); // a forced model wins
  });

  it('follows the config', () => {
    const c = defaultConfig();
    c.routing.plannerLight = 'haiku';
    c.routing.planner = 'sonnet';
    expect(plannerTier({ complexity: 'multi_file' }, c)).toBe('haiku');
    expect(plannerTier({ complexity: 'large_build' }, c)).toBe('sonnet');
  });

  it('the planner call uses the model for the task size', async () => {
    const big = setup({ complexities: ['large_build'] });
    await big.pipeline.runTask('build an app', { autoApprove: true });
    expect(big.calls.find((c) => c.role === 'planner')?.model).toBe('opus');
    const mid = setup({ complexities: ['multi_file'], classifier: { needsPlan: true } });
    await mid.pipeline.runTask('add login and signup and tests', { autoApprove: true });
    expect(mid.calls.find((c) => c.role === 'planner')?.model).toBe('sonnet');
  });
});

describe('docs-only changes are not checked', () => {
  it('isDocsOnly: prose and images yes; code, config and empty lists no', async () => {
    const { isDocsOnly } = await import('../../src/core/verifier.js');
    expect(isDocsOnly(['README.md', 'docs/guide.mdx', 'notes.txt', 'img/logo.png'])).toBe(true);
    expect(isDocsOnly(['LICENSE', 'CHANGELOG'])).toBe(true);
    expect(isDocsOnly(['README.md', 'src/a.ts'])).toBe(false);
    expect(isDocsOnly(['package.json'])).toBe(false);
    expect(isDocsOnly(['tsconfig.json', 'ci.yml'])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });

  it('a step that only edits the README does not run the project checks, a code edit does', async () => {
    const ran: string[] = [];
    const ok = { isError: false, subtype: 'success', text: 'ok', usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    const mk = (file: string) => {
      const config = defaultConfig();
      config.review.enabled = false;
      config.verify.commands = ['npm run lint'];
      const run: RunClaudeFn = async (o) => {
        const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        if (props && 'complexity' in props) return { ...ok, structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' } };
        o.onEvent?.({ kind: 'tool', name: 'Write', summary: `Write ${file}`, writtenFile: join(t.cwd, file) });
        return { ...ok, structured: undefined };
      };
      const exec = async (cmd: string) => { ran.push(cmd); return { code: 0, output: '' }; };
      const t = { cwd: mkdtempSync(join(tmpdir(), 'smart-docs-')) };
      return new Pipeline(config, new EventBus(), t.cwd, { run, exec: exec as never, uid: 1000, listFiles: () => [] });
    };
    await mk('README.md').runTask('update the readme');
    expect(ran).toEqual([]);
    await mk('src/app.ts').runTask('change the app');
    expect(ran).toEqual(['npm run lint']);
  });
});

