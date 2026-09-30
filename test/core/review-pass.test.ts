import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callError, limitFailure, type ClaudeResult, type RunClaudeFn } from '../../src/core/claude.js';
import { createCheckpoints, type Checkpointer } from '../../src/core/checkpoint.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { limitError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { ConversationStore, newConversation, type Conversation } from '../../src/core/store/conversation.js';
import { Tracker } from '../../src/core/store/tracker.js';
import { emptyUsage } from '../../src/core/types.js';
import { detectChecks, packageManager } from '../../src/core/verifier.js';

const tmp = (p = 'smart-rp-') => mkdtempSync(join(tmpdir(), p));
const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1, ...over });
const made: Checkpointer[] = [];
afterEach(() => made.splice(0).forEach((c) => c.dispose()));

type Role = 'classifier' | 'planner' | 'reviewer' | 'executor';
const roleOf = (o: Parameters<RunClaudeFn>[0]): Role => {
  const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : props && 'pass' in props ? 'reviewer' : 'executor';
};

async function setup(opts: {
  git?: boolean;
  classifier?: Record<string, unknown>;
  steps?: object[];
  executor?: (n: number, cwd: string) => ClaudeResult | void;
  config?: (c: SmartConfig) => void;
  cwd?: string;
  conversation?: Conversation;
  store?: ConversationStore;
} = {}) {
  const cwd = opts.cwd ?? tmp();
  if (opts.git && !opts.cwd) {
    for (const a of [['init', '-q'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 't'], ['config', 'core.autocrlf', 'false']]) execFileSync('git', a, { cwd });
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    writeFileSync(join(cwd, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd });
  }
  const checkpoints = opts.git ? await createCheckpoints(cwd) : undefined;
  if (checkpoints) made.push(checkpoints);
  const calls: { role: Role; model: string; prompt: string }[] = [];
  let n = 0;
  const run: RunClaudeFn = async (o) => {
    const role = roleOf(o);
    calls.push({ role, model: o.model, prompt: o.prompt });
    if (role === 'classifier') return res({ structured: { complexity: 'small_edit', needsPlan: false, reason: 'r', ...opts.classifier } });
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: opts.steps ?? [{ title: 'A', instructions: 'do a', acceptance: ['x'] }, { title: 'B', instructions: 'do b', acceptance: ['y'] }] } });
    if (role === 'reviewer') return res({ structured: { pass: true, issues: [] } });
    n += 1;
    return opts.executor?.(n, cwd) ?? res({ text: 'did it' });
  };
  const config = defaultConfig();
  config.verify.auto = false;
  config.review.enabled = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, cwd, { run, uid: 1000, listFiles: () => [], checkpoints, conversation: opts.conversation, conversationStore: opts.store });
  return { pipeline, calls, cwd, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('usage limit reached', () => {
  it('is recognised in the messages Claude Code uses, with the reset time when given', () => {
    expect(limitFailure('Claude AI usage limit reached|1759255200')).toEqual({ message: 'Claude AI usage limit reached', resetsAt: 1759255200 });
    expect(limitFailure("You've hit your limit · resets 5pm (Europe/Berlin)")?.message).toContain('resets 5pm');
    expect(limitFailure('5-hour limit reached ∙ resets 3pm')).not.toBeNull();
    expect(limitFailure('Weekly limit reached')).not.toBeNull();
    expect(limitFailure('Error: max turns reached')).toBeNull();
    expect(limitFailure('the rate limiter in worker.js is wrong')).toBeNull();
    expect(limitFailure(`I added a check so the API returns "usage limit reached" when the quota is spent. ${'Details. '.repeat(60)}`)).toBeNull(); // model output
  });

  it('becomes a limit error; not-logged-in stays an auth error and anything else a claude error', () => {
    expect(callError('Claude AI usage limit reached|1759255200', 'x')).toMatchObject({ kind: 'limit', resetsAt: 1759255200 });
    expect(callError('Invalid API key · Please run /login', 'x').kind).toBe('auth');
    expect(callError('boom', 'Claude Code failed')).toMatchObject({ kind: 'claude', message: 'Claude Code failed: boom' });
  });

  it('stops the task at once (no retry, no escalation to a bigger model) and keeps it resumable, even in the first step', async () => {
    const t = await setup({ executor: () => { throw limitError('Claude AI usage limit reached', Math.floor(Date.now() / 1000) + 7200); } });
    const out = await t.pipeline.runTask('make the parser handle empty input');
    expect(out.ok).toBe(false);
    expect(t.calls.filter((c) => c.role === 'executor')).toHaveLength(1);
    expect(t.of('step:escalate')).toHaveLength(0);
    const err = t.of('error')[0]!;
    expect(err.kind).toBe('limit');
    expect(err.message).toMatch(/usage limit is reached.*resets in (1h 59m|2h 00m)/);
    expect(err.hint).toContain('/resume');
    expect(t.pipeline.pendingTask?.prompt).toBe('make the parser handle empty input'); // /resume continues it
  });

  it('also stops planning and classifying calls instead of degrading to a fallback', async () => {
    const run: RunClaudeFn = async () => { throw limitError('usage limit reached'); };
    const bus = new EventBus();
    const events: SmartEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const p = new Pipeline(defaultConfig(), bus, tmp(), { run, uid: 1000, listFiles: () => [] });
    await p.runTask('build a job runner with a scheduler');
    // Nothing ran, so there is nothing to /resume: the hint says to send it again.
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'limit', hint: 'Send the task again once it resets.' });
    expect(events.some((e) => e.type === 'classified')).toBe(false);
    expect(p.pendingTask).toBeNull();
  });
});

describe('answering questions', () => {
  it('keeps the classifier\'s answer for a question it rated easy, even when a keyword rule names Opus', async () => {
    const t = await setup({ classifier: { complexity: 'trivial', difficulty: 'easy', answer: 'A deadlock is two waits on each other.' } });
    await t.pipeline.runTask('what is a deadlock?');
    expect(t.calls.map((c) => c.role)).toEqual(['classifier']);
    expect(t.pipeline.lastReplyText).toBe('A deadlock is two waits on each other.');
  });

  it('a question rated normal or hard is still answered by the model the rater picks, not forced to Opus by a keyword', async () => {
    const t = await setup({ classifier: { complexity: 'trivial', difficulty: 'normal', answer: 'draft' } });
    await t.pipeline.runTask('why does my architecture of the plugin loader matter for startup time, and what are the trade-offs?');
    const answer = t.calls[1];
    expect(answer?.role).toBe('executor');
    expect(answer?.model).toBe('sonnet');
  });
});

describe('/undo', () => {
  it('reverts only the files the task changed, not your own later edits to other files', async () => {
    const t = await setup({ git: true, executor: (_n, cwd) => { writeFileSync(join(cwd, 'a.txt'), 'TASK\n'); } });
    await t.pipeline.runTask('change a');
    writeFileSync(join(t.cwd, 'b.txt'), 'MY OWN EDIT\n'); // made by you after the task
    writeFileSync(join(t.cwd, 'mine.txt'), 'new file of yours\n');
    await t.pipeline.undo();
    expect(readFileSync(join(t.cwd, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(t.cwd, 'b.txt'), 'utf8')).toBe('MY OWN EDIT\n');
    expect(existsSync(join(t.cwd, 'mine.txt'))).toBe(true);
  });

  it('marks the task that was undone as reverted in memory, not whatever came last', async () => {
    const t = await setup({
      git: true,
      executor: (n, cwd) => (n === 1 ? void writeFileSync(join(cwd, 'a.txt'), 'TASK\n') : res({ text: 'just an answer' })),
    });
    await t.pipeline.runTask('change a');
    await t.pipeline.runTask('make the parser handle empty input'); // changes no file
    await t.pipeline.undo();
    await t.pipeline.runTask('what next');
    const memory = t.calls.filter((c) => c.role === 'classifier').at(-1)!.prompt;
    expect(memory).toContain('"change a" → reverted');
    expect(memory).toContain('"make the parser handle empty input" → done');
    expect(t.calls.filter((c) => c.role === 'executor').at(-1)!.prompt).toContain('undid your file changes from the task "change a"');
  });

  it('works after quitting and starting smart again, and survives /new', async () => {
    const store = new ConversationStore(join(tmp(), 'conversations.json'));
    const first = await setup({ git: true, store, executor: (_n, cwd) => { writeFileSync(join(cwd, 'a.txt'), 'TASK\n'); } });
    await first.pipeline.runTask('change a');
    // A new process: a fresh conversation that carries the directory's undo history (as the CLI does).
    const stored = store.load(first.cwd);
    expect(stored?.undo).toHaveLength(1);
    const second = await setup({ git: true, cwd: first.cwd, store, conversation: { ...newConversation(), undo: stored!.undo } });
    second.pipeline.newConversation();
    await second.pipeline.diff();
    expect(second.of('diff')[0]?.text).toContain('+TASK');
    await second.pipeline.undo();
    expect(readFileSync(join(first.cwd, 'a.txt'), 'utf8')).toBe('a\n');
    expect(store.load(first.cwd)?.undo).toBeUndefined();
  });
});

describe('history file', () => {
  it('is written compactly and re-read only when it changed', () => {
    const path = join(tmp(), 'history.json');
    const t = new Tracker(path);
    const rec = { id: 't1', startedAt: new Date().toISOString(), prompt: 'p', overhead: emptyUsage(), steps: [], totals: emptyUsage(), ok: true };
    expect(t.append(rec)).toBeNull();
    expect(readFileSync(path, 'utf8')).not.toContain('\n  ');
    const a = t.load();
    const b = t.load();
    expect(b).toEqual(a);
    expect(b).not.toBe(a); // callers get their own array
    // Another smart session appends: the next load sees it.
    new Tracker(path).append({ ...rec, id: 't2' });
    expect(t.load().map((x) => x.id)).toEqual(['t1', 't2']);
  });
});

describe('automatic checks use the project\'s package manager', () => {
  const project = (files: Record<string, string>) => {
    const dir = tmp();
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
    return dir;
  };
  const pkg = (extra: object = {}) => JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' }, ...extra });
  const all = () => true;

  it('from the lockfile, or package.json\'s packageManager field', () => {
    expect(packageManager(project({ 'pnpm-lock.yaml': '' }), {}, all)).toBe('pnpm');
    expect(packageManager(project({ 'yarn.lock': '' }), {}, all)).toBe('yarn');
    expect(packageManager(project({ 'bun.lock': '' }), {}, all)).toBe('bun');
    expect(packageManager(project({}), {}, all)).toBe('npm');
    expect(packageManager(project({ 'yarn.lock': '' }), { packageManager: 'pnpm@9.1.0' }, all)).toBe('pnpm');
  });

  it('falls back to npm when that tool is not installed', () => {
    expect(packageManager(project({ 'pnpm-lock.yaml': '' }), {}, () => false)).toBe('npm');
  });

  it('builds the right commands', () => {
    const c = defaultConfig();
    expect(detectChecks(project({ 'package.json': pkg(), 'pnpm-lock.yaml': '' }), c, all).map((x) => x.command)).toEqual(['pnpm run lint', 'pnpm run test']);
    expect(detectChecks(project({ 'package.json': pkg(), 'yarn.lock': '' }), c, all).map((x) => x.command)).toEqual(['yarn lint', 'yarn test']);
    expect(detectChecks(project({ 'package.json': pkg() }), c, () => { throw new Error('npm needs no probe'); }).map((x) => x.command)).toEqual(['npm run lint', 'npm run test']);
  });
});
