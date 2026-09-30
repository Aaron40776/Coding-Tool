import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { EventBus, type SmartEvent } from '../src/core/events.js';
import { foldersOf } from '../src/core/files.js';
import { resolveMentions } from '../src/core/mentions.js';
import { Pipeline } from '../src/core/pipeline.js';
import { buildCostTable, estimateStep, formatEstimate } from '../src/core/rating/estimate.js';
import { buildHistory } from '../src/core/rating/learn.js';
import { Tracker, type StepRecord, type TaskRecord } from '../src/core/store/tracker.js';
import { emptyUsage, type Plan, type RouteDecision } from '../src/core/types.js';
import { PlanApproval } from '../src/ui/components/PlanApproval.js';
import { parseInput } from '../src/ui/commands.js';
import { KEYS, wait, waitFor } from './ui/helpers.js';

const tmp = (p = 'smart-b3-') => mkdtempSync(join(tmpdir(), p));
const step = (cost: number, rated: StepRecord['rated'], over: Partial<StepRecord> = {}): StepRecord => ({
  stepId: 's', title: 't', model: 'sonnet', tier: 'sonnet', attempts: 1, escalated: false, usage: { ...emptyUsage(), costUsd: cost }, outcome: 'done', rated, ...over,
});
const task = (steps: StepRecord[], over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: `t${Math.random()}`, startedAt: new Date().toISOString(), prompt: 'p', overhead: emptyUsage(), steps, totals: emptyUsage(), ok: true, ...over,
});

describe('cost estimate', () => {
  it('uses the median of your own clean steps on the same model and effort, once there are a few', () => {
    const rated = { tier: 'sonnet', effort: 'medium', score: 0.3 };
    const table = buildCostTable([task([step(0.1, rated), step(0.2, rated), step(0.9, rated)]), task([step(5, rated, { attempts: 2 })])]);
    expect(estimateStep({ tier: 'sonnet', effort: 'medium' }, table)).toEqual({ usd: 0.2, basis: 3 }); // the retried $5 step is left out
    expect(estimateStep({ tier: 'opus', effort: 'high' }, table).basis).toBe(0); // no history: a rough guess
    expect(estimateStep({ tier: 'sonnet', effort: 'medium' }, buildCostTable([task([step(0.1, rated)])])).basis).toBe(0); // one step is not enough
  });

  it('formats a total and says when it is rough', () => {
    expect(formatEstimate([{ usd: 0.2, basis: 3 }, { usd: 0.25, basis: 4 }])).toBe('≈ $0.45');
    expect(formatEstimate([{ usd: 0.05, basis: 0 }])).toBe('≈ $0.050 (rough)');
  });
});

describe('plan review follows your edits', () => {
  const plan: Plan = {
    summary: 'Build it', features: [], fileStructure: [],
    steps: [
      { id: 's1', title: 'Scaffold', instructions: 'set up the folders', files: [], acceptance: [], difficulty: 'easy' },
      { id: 's2', title: 'Queue', instructions: 'write the queue', files: [], acceptance: [], difficulty: 'normal' },
    ],
  };
  const pipeline = () => new Pipeline(defaultConfig(), new EventBus(), tmp(), { run: async () => { throw new Error('no calls'); }, uid: 1000, listFiles: () => [] });

  it('previewStep re-rates a step when its model or text changes', () => {
    const p = pipeline();
    const base = p.previewStep(plan, plan.steps[1]!);
    expect(base.route.tier).toBe('sonnet');
    expect(p.previewStep(plan, { ...plan.steps[1]!, tier: 'opus' }).route.tier).toBe('opus');
    const harder = p.previewStep(plan, { ...plan.steps[1]!, instructions: 'fix the race condition and deadlock in the lock-free queue', difficulty: 'hard' });
    expect(harder.route.tier).toBe('opus');
    expect(harder.estimate.usd).toBeGreaterThan(base.estimate.usd);
  });

  it('the review screen shows the estimate and updates badge and estimate when you change a model', async () => {
    const p = pipeline();
    const routes: Record<string, RouteDecision> = {};
    const { stdin, lastFrame } = render(<PlanApproval plan={plan} routes={routes} preview={(pl, st) => p.previewStep(pl, st)} onApprove={() => undefined} onCancel={() => undefined} height={30} width={120} />);
    const before = /≈ \$([\d.]+)/.exec(lastFrame()!)?.[1];
    expect(before).toBeDefined();
    expect(lastFrame()).toContain('if every step passes first time');
    stdin.write(KEYS.down);
    await wait();
    for (let i = 0; i < 3; i++) {
      stdin.write('m'); // cycle to opus
      await wait();
    }
    await waitFor(() => lastFrame()!.includes('(yours)'));
    const after = /≈ \$([\d.]+)/.exec(lastFrame()!)?.[1];
    expect(Number(after)).toBeGreaterThan(Number(before));
  });

  it('editing text has a real cursor: move left and type in the middle', async () => {
    let approved: Plan | undefined;
    const { stdin } = render(<PlanApproval plan={plan} routes={{}} onApprove={(pl) => { approved = pl; }} onCancel={() => undefined} height={30} width={120} />);
    stdin.write('e'); // edit the title "Scaffold"
    await wait();
    for (let i = 0; i < 4; i++) {
      stdin.write(KEYS.left);
      await wait(10);
    }
    stdin.write('X');
    await wait();
    stdin.write(KEYS.enter); // save
    await wait();
    stdin.write(KEYS.enter); // run
    await waitFor(() => approved !== undefined);
    expect(approved!.steps[0]!.title).toBe('ScafXfold');
  });
});

describe('/good and /bad', () => {
  it('parse as commands', () => {
    expect(parseInput('/good')).toEqual({ kind: 'feedback', value: 'good' });
    expect(parseInput('/bad')).toEqual({ kind: 'feedback', value: 'bad' });
  });

  it('a /bad result counts as a miss for its rung, even though it passed first try', () => {
    const rated = { tier: 'sonnet', effort: 'low', score: 0.2 };
    const good = buildHistory([task([step(0.1, rated)])]);
    const bad = buildHistory([task([step(0.1, rated)], { feedback: 'bad' })]);
    expect(good.get('sonnet/low/low')).toEqual({ n: 1, ok: 1 });
    expect(bad.get('sonnet/low/low')).toEqual({ n: 1, ok: 0 });
  });

  it('are saved on the last task and explained', async () => {
    const tracker = new Tracker(join(tmp(), 'history.json'));
    const bus = new EventBus();
    const events: SmartEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const run = async (o: { jsonSchema?: object }) => {
      const props = (o.jsonSchema as { properties?: object } | undefined)?.properties;
      if (props && 'complexity' in props) return { isError: false, subtype: 'success', text: '', structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' }, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1 };
      return { isError: false, subtype: 'success', text: 'done', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.05 }, sessionId: 's', numTurns: 1 };
    };
    const config = defaultConfig();
    config.verify.auto = false;
    config.review.enabled = false;
    const p = new Pipeline(config, bus, tmp(), { run, tracker, uid: 1000, listFiles: () => [] });
    p.rateLast('bad');
    expect((events.at(-1) as { message: string }).message).toContain('No finished task');
    await p.runTask('make the parser handle empty input');
    p.rateLast('bad');
    expect(tracker.load().at(-1)?.feedback).toBe('bad');
    expect((events.at(-1) as { message: string }).message).toMatch(/Noted as wrong: it counts against sonnet · \w+ for similar work/);
  });
});

describe('@folder', () => {
  it('attaches the folder\'s file list; a folder outside the project is not read', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, 'src', 'ui'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'a.ts'), 'a');
    writeFileSync(join(cwd, 'src', 'ui', 'b.tsx'), 'b');
    writeFileSync(join(cwd, 'README.md'), 'hello');
    const got = resolveMentions(cwd, 'tidy up @src/ and @README.md and @../', 40_000);
    const folder = got.find((f) => f.path === 'src/');
    expect(folder?.content).toContain('src/a.ts');
    expect(folder?.content).toContain('src/ui/b.tsx');
    expect(got.find((f) => f.path === 'README.md')?.content).toBe('hello');
    expect(got.some((f) => f.path.startsWith('..'))).toBe(false);
  });

  it('folders are offered by @ completion', () => {
    expect(foldersOf(['src/a.ts', 'src/ui/b.tsx', 'README.md'])).toEqual(['src/', 'src/ui/']);
  });
});
