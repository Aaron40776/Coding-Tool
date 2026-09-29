import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { CostMeter } from '../../src/ui/components/CostMeter.js';
import { InputBox, matchFiles, windowText } from '../../src/ui/components/InputBox.js';
import { inlineSegments, OutputLog, toRows, wrapText } from '../../src/ui/components/OutputLog.js';
import { PipelineBar } from '../../src/ui/components/PipelineBar.js';
import { budget, PlanApproval } from '../../src/ui/components/PlanApproval.js';
import { PlanChecklist } from '../../src/ui/components/PlanChecklist.js';
import { StatsView } from '../../src/ui/components/StatsView.js';
import { LimitsMeter } from '../../src/ui/components/LimitsMeter.js';
import { defaultConfig } from '../../src/core/config.js';
import { summarize } from '../../src/core/stats.js';
import { StepBadge } from '../../src/ui/components/StepBadge.js';
import { fmtCost, fmtDuration, fmtTokens } from '../../src/ui/format.js';
import { matchCommands } from '../../src/ui/commands.js';
import { initialStages } from '../../src/ui/state.js';
import { emptyUsage, type Plan, type RouteDecision } from '../../src/core/types.js';
import { KEYS, wait, waitFor } from './helpers.js';

const plan: Plan = {
  summary: 'Snake game',
  features: [],
  fileStructure: [],
  steps: [
    { id: 's1', title: 'Scaffold canvas', instructions: 'Create index.html', files: ['a.html'], acceptance: ['opens'] },
    { id: 's2', title: 'Snake movement', instructions: 'Add loop', files: [], acceptance: [] },
    { id: 's3', title: 'Collision', instructions: 'Add walls', files: [], acceptance: [] },
  ],
};
const route = (tier: 'haiku' | 'sonnet' | 'opus', reason = 'multi_file → sonnet'): RouteDecision => ({ tier, model: tier, reason });
const routes = { s1: route('sonnet'), s2: route('sonnet'), s3: route('opus', 'keyword "race" → opus') };

describe('format', () => {
  it('formats cost and tokens', () => {
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(18_300)).toBe('18.3k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
    expect(fmtDuration(400)).toBe('0s');
    expect(fmtDuration(59_400)).toBe('59s');
    expect(fmtDuration(125_000)).toBe('2m 05s');
  });
});

describe('StepBadge', () => {
  it('shows the model name and an escalation arrow', () => {
    expect(render(<StepBadge tier="haiku" />).lastFrame()).toContain('Haiku');
    expect(render(<StepBadge tier="sonnet" />).lastFrame()).toContain('Sonnet');
    const esc = render(<StepBadge tier="opus" escalated />).lastFrame();
    expect(esc).toContain('Opus');
    expect(esc).toContain('↑');
  });
});

describe('CostMeter', () => {
  it('shows session totals, and task totals only when asked', () => {
    const u = { ...emptyUsage(), costUsd: 0.5, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000 };
    const withTask = render(<CostMeter task={{ ...u, costUsd: 0.1 }} session={u} showTask />).lastFrame()!;
    expect(withTask).toContain('task $0.10');
    expect(withTask).toContain('session $0.50');
    expect(withTask).toContain('cache 5.0k');
    expect(render(<CostMeter task={u} session={u} showTask={false} />).lastFrame()).not.toContain('task');
  });
});

describe('PipelineBar', () => {
  it('shows all four stages with status marks', () => {
    const f = render(<PipelineBar stages={{ ...initialStages(), classify: 'done', plan: 'failed', execute: 'skipped' }} />).lastFrame()!;
    for (const s of ['classify', 'plan', 'execute', 'verify']) expect(f).toContain(s);
    expect(f).toContain('✓');
    expect(f).toContain('✗');
    expect(f).toContain('–');
    expect(f).toContain('○');
  });
  it('flags the plan stage as under review while approving', () => {
    expect(render(<PipelineBar stages={{ ...initialStages(), classify: 'done', approve: 'active' }} />).lastFrame()).toContain('(review)');
  });
});

describe('PlanChecklist', () => {
  it('ticks steps live and shows a badge and routing reason per step', () => {
    const f = render(
      <PlanChecklist plan={plan} routes={routes} stepStatus={{ s1: 'done', s2: 'active', s3: 'pending' }} escalatedTo={{}} />,
    ).lastFrame()!;
    expect(f).toContain('✓');
    expect(f).toContain('1. Scaffold canvas');
    expect(f).toContain('Sonnet');
    expect(f).toContain('Opus');
    expect(f).toContain('multi_file → sonnet');
    expect(f).toContain('keyword "race" → opus');
  });
  it('shows escalation and skipped steps', () => {
    const f = render(
      <PlanChecklist
        plan={{ ...plan, steps: [plan.steps[0]!, { ...plan.steps[1]!, skipped: true }, plan.steps[2]!] }}
        routes={routes}
        stepStatus={{ s1: 'failed', s3: 'pending' }}
        escalatedTo={{ s1: 'opus' }}
      />,
    ).lastFrame()!;
    expect(f).toContain('✗');
    expect(f).toContain('escalated from sonnet');
    expect(f).toContain('–');
  });
  it('has an empty state', () => {
    expect(render(<PlanChecklist routes={{}} stepStatus={{}} escalatedTo={{}} />).lastFrame()).toContain('No plan yet');
  });
});

describe('OutputLog', () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, kind: 'text' as const, text: `line ${i + 1}` }));
  it('shows the newest lines and scrolls up on request', () => {
    const tail = render(<OutputLog lines={lines} height={8} scroll={0} />).lastFrame()!;
    expect(tail).toContain('line 30');
    expect(tail).not.toContain('line 1\n');
    const scrolled = render(<OutputLog lines={lines} height={8} scroll={10} />).lastFrame()!;
    expect(scrolled).toContain('line 20');
    expect(scrolled).not.toContain('line 30');
    expect(scrolled).toContain('scrolled 10 up');
  });
  it('renders the welcome text when empty', () => {
    expect(render(<OutputLog lines={[]} height={8} scroll={0} welcome={['Hello there']} />).lastFrame()).toContain('Hello there');
  });
  it('word-wraps long lines but keeps tool lines on one row', () => {
    expect(wrapText('aaa bbb ccc ddd', 10)).toEqual(['aaa bbb', 'ccc ddd']);
    expect(wrapText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    const rows = toRows([{ id: 1, kind: 'info', text: 'word '.repeat(20).trim() }, { id: 2, kind: 'tool', text: 'Edit ' + 'p/'.repeat(30) }], 30);
    expect(rows.filter((r) => r.kind === 'info').length).toBeGreaterThan(2);
    expect(rows.filter((r) => r.kind === 'tool')).toHaveLength(1);
  });
  it('caps very long multi-line entries', () => {
    const rows = toRows([{ id: 1, kind: 'verify-fail', text: Array.from({ length: 40 }, (_, i) => `e${i}`).join('\n') }]);
    expect(rows).toHaveLength(9);
    expect(rows.at(-1)?.text).toMatch(/32 more lines/);
  });
});

describe('InputBox', () => {
  it('types, edits and submits', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} active placeholder="What now?" tags={['dry-run']} />);
    expect(lastFrame()).toContain('What now?');
    expect(lastFrame()).toContain('[dry-run]');
    stdin.write('helo');
    await wait();
    stdin.write(KEYS.left);
    await wait();
    stdin.write('l');
    await wait();
    expect(lastFrame()).toContain('hello');
    stdin.write(KEYS.backspace);
    await wait();
    expect(lastFrame()).not.toContain('hello');
    stdin.write('l');
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => onSubmit.mock.calls.length === 1);
    expect(onSubmit).toHaveBeenCalledWith('hello');
    await waitFor(() => lastFrame()!.includes('What now?')); // input cleared
  });
  it('keeps every keystroke when several arrive in the same tick', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active />);
    for (const ch of 'abcdef') stdin.write(ch);
    for (let i = 0; i < 2; i++) stdin.write(KEYS.backspace);
    await wait();
    expect(lastFrame()).toContain('abcd');
    expect(lastFrame()).not.toContain('abcde');
  });
  it('recalls history with the arrow keys and ignores empty submits', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} active />);
    stdin.write(KEYS.enter);
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write('first');
    await wait();
    stdin.write(KEYS.enter);
    await wait();
    stdin.write(KEYS.up);
    await wait();
    expect(lastFrame()).toContain('first');
  });
  it('does not treat pasted text with a trailing newline as a submit', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} active />);
    stdin.write('pasted line\r');
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('pasted line');
  });
  it('ignores keys when inactive and shows busy text', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active={false} busyText="Working…" />);
    stdin.write('abc');
    await wait();
    expect(lastFrame()).toContain('Working…');
    expect(lastFrame()).not.toContain('abc');
  });
});

describe('input features', () => {
  it('windowText keeps the cursor visible in a long line', () => {
    const long = 'x'.repeat(200);
    const w = windowText(long, 200, 40);
    expect(w.before.length + w.at.length + w.after.length).toBeLessThanOrEqual(40);
    expect(w.before.startsWith('…')).toBe(true);
    expect(windowText('short', 2, 40)).toEqual({ before: 'sh', at: 'o', after: 'rt' });
    const mid = windowText('abcdefghij'.repeat(10), 50, 20);
    expect(mid.before.length + 1 + mid.after.length).toBeLessThanOrEqual(20);
  });

  it('a very long prompt stays on one line inside the box', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active width={60} />);
    stdin.write('word '.repeat(60));
    await wait();
    const frame = lastFrame()!;
    expect(frame.split('\n')).toHaveLength(3); // top border, one line, bottom border
    expect(frame).toContain('…');
  });

  it('Tab completes a slash command and reports drafts', async () => {
    const drafts: string[] = [];
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active completions={['/stats', '/model', '/dry']} onDraft={(d) => drafts.push(d)} />);
    stdin.write('/mo');
    await wait();
    stdin.write(KEYS.tab);
    await wait();
    expect(lastFrame()).toContain('/model');
    expect(drafts.at(-1)).toBe('/model ');
  });

  it('starts with the history it is given', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active initialHistory={['older', 'newer']} />);
    stdin.write(KEYS.up);
    await wait();
    expect(lastFrame()).toContain('newer');
    stdin.write(KEYS.up);
    await wait();
    expect(lastFrame()).toContain('older');
  });

  it('a trailing backslash then Enter adds a line instead of sending; the whole text is sent on the next Enter', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} active />);
    stdin.write('first line\\');
    await wait();
    stdin.write(KEYS.enter);
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('first line↵');
    stdin.write('second line');
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => onSubmit.mock.calls.length === 1);
    expect(onSubmit).toHaveBeenCalledWith('first line\nsecond line');
  });

  it('pasted multi-line text keeps its line breaks and never submits', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} active />);
    stdin.write('line one\r\nline two\r\n');
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('line one↵line two');
    stdin.write(KEYS.enter);
    await waitFor(() => onSubmit.mock.calls.length === 1);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });

  it('matchFiles ranks prefix matches first and only applies to a trailing @word', () => {
    const files = ['src/app.ts', 'test/app.test.ts', 'README.md', 'src/util.ts'];
    expect(matchFiles('fix @src/', files)).toEqual({ prefix: 'src/', matches: ['src/app.ts', 'src/util.ts'] });
    expect(matchFiles('@app', files)?.matches).toEqual(['src/app.ts', 'test/app.test.ts']);
    expect(matchFiles('@readme', files)?.matches).toEqual(['README.md']);
    expect(matchFiles('no mention', files)).toBeNull();
    expect(matchFiles('mail a@b', files)).toBeNull();
    expect(matchFiles('@src/app.ts and more', files)).toBeNull(); // the @word is no longer at the end
  });

  it('Tab completes an @file reference (a unique match, or the common prefix)', async () => {
    const { stdin, lastFrame } = render(<InputBox onSubmit={() => undefined} active files={['src/app.ts', 'src/apple.ts', 'docs/guide.md']} />);
    stdin.write('look at @src/ap');
    await wait();
    stdin.write(KEYS.tab);
    await wait();
    expect(lastFrame()).toContain('@src/app'); // common prefix of app.ts and apple.ts
    stdin.write('l');
    await wait();
    stdin.write(KEYS.tab);
    await wait();
    expect(lastFrame()).toContain('@src/apple.ts');
    stdin.write('x');
    await wait();
    expect(lastFrame()).not.toContain('@src/apple.tsx@'); // completed with a trailing space
  });

  it('matchCommands suggests by prefix only for a bare slash word', () => {
    expect(matchCommands('/')).toEqual(['/stats', '/usage', '/cost', '/config', '/model', '/dry', '/new', '/undo', '/diff', '/mode', '/help', '/quit']);
    expect(matchCommands('/c')).toEqual(['/cost', '/config']);
    expect(matchCommands('/d')).toEqual(['/dry', '/diff']);
    expect(matchCommands('/st')).toEqual(['/stats']);
    expect(matchCommands('/model opus')).toEqual([]);
    expect(matchCommands('hello')).toEqual([]);
  });

  it('inlineSegments styles bold, code, headings and bullets', () => {
    expect(inlineSegments('use **bold** and `code` here')).toEqual([
      { text: 'use ', style: 'plain' }, { text: 'bold', style: 'bold' }, { text: ' and ', style: 'plain' }, { text: 'code', style: 'code' }, { text: ' here', style: 'plain' },
    ]);
    expect(inlineSegments('## Heading')).toEqual([{ text: 'Heading', style: 'bold' }]);
    expect(inlineSegments('- item')[0]?.text).toBe('• item');
    expect(inlineSegments('plain')).toEqual([{ text: 'plain', style: 'plain' }]);
  });
});

describe('PlanApproval', () => {
  const setup = () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    const r = render(<PlanApproval plan={plan} routes={routes} onApprove={onApprove} onCancel={onCancel} />);
    return { ...r, onApprove, onCancel };
  };

  it('lists steps with badges, reasons and details', () => {
    const f = setup().lastFrame()!;
    expect(f).toContain('Review plan');
    expect(f).toContain('Scaffold canvas');
    expect(f).toContain('Opus');
    expect(f).toContain('Create index.html');
    expect(f).toContain('Model: multi_file → sonnet');
    expect(f).toContain('Files: a.html');
  });

  it('approves the unchanged plan with Enter', async () => {
    const { stdin, onApprove } = setup();
    stdin.write(KEYS.enter);
    await waitFor(() => onApprove.mock.calls.length === 1);
    expect(onApprove.mock.calls[0]![0].steps.every((s: { skipped?: boolean }) => !s.skipped)).toBe(true);
  });

  it('skips a step with Space and passes the edited plan on approve', async () => {
    const { stdin, lastFrame, onApprove } = setup();
    stdin.write(KEYS.down);
    await wait();
    stdin.write(' ');
    await wait();
    expect(lastFrame()).toContain('[ ] 2. Snake movement');
    stdin.write(KEYS.enter);
    await waitFor(() => onApprove.mock.calls.length === 1);
    expect(onApprove.mock.calls[0]![0].steps.map((s: { skipped?: boolean }) => Boolean(s.skipped))).toEqual([false, true, false]);
  });

  it('lets the user override the model with m', async () => {
    const { stdin, lastFrame, onApprove } = setup();
    stdin.write('m');
    await wait();
    expect(lastFrame()).toContain('(yours)');
    stdin.write(KEYS.enter);
    await waitFor(() => onApprove.mock.calls.length === 1);
    expect(onApprove.mock.calls[0]![0].steps[0].tier).toBe('haiku');
  });

  it('edits a step title inline', async () => {
    const { stdin, lastFrame, onApprove } = setup();
    stdin.write('e');
    await wait();
    expect(lastFrame()).toContain('Editing title');
    for (let i = 0; i < 'Scaffold canvas'.length; i++) stdin.write(KEYS.backspace);
    await wait();
    stdin.write('New title');
    await wait();
    stdin.write(KEYS.enter);
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => onApprove.mock.calls.length === 1);
    expect(onApprove.mock.calls[0]![0].steps[0].title).toBe('New title');
  });

  it('refuses to approve when every step is skipped', async () => {
    const { stdin, lastFrame, onApprove } = setup();
    for (let i = 0; i < 3; i++) {
      stdin.write(' ');
      await wait();
      stdin.write(KEYS.down);
      await wait();
    }
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('Every step is skipped'));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('cancels with Esc', async () => {
    const { stdin, onCancel } = setup();
    stdin.write(KEYS.esc);
    await waitFor(() => onCancel.mock.calls.length === 1);
  });
});

describe('PlanApproval: long plans on small terminals (regression)', () => {
  const longText = 'Implement the game loop with a fixed timestep, keep state immutable, and make randomness injectable so tests are deterministic. ';
  const bigPlan: Plan = {
    summary: 'A browser game with a pure logic module and a canvas front end, built in small verifiable steps. '.repeat(3),
    features: [],
    fileStructure: [],
    steps: Array.from({ length: 9 }, (_, i) => ({
      id: `s${i + 1}`, title: `Step ${i + 1}: ${'A rather long step title that needs wrapping '.repeat(2)}`, instructions: `${longText.repeat(4)}END-OF-STEP-${i + 1}`,
      files: ['a.js', 'b.js'], acceptance: ['first criterion that is fairly long and descriptive', 'second criterion', 'third criterion'],
    })),
  };
  const routes9 = Object.fromEntries(bigPlan.steps.map((s) => [s.id, route('sonnet')]));

  it('budget() never allocates more rows than exist', () => {
    for (let inner = 10; inner <= 60; inner++) {
      for (const steps of [1, 3, 9, 20]) {
        for (const warn of [false, true]) {
          const { list, detail } = budget(inner, 2, steps, warn);
          expect(list).toBeGreaterThanOrEqual(1);
          expect(detail).toBeGreaterThanOrEqual(1);
          if (inner >= 16) expect(1 + 2 + 1 + list + 1 + 2 + detail + 1 + (warn ? 1 : 0)).toBeLessThanOrEqual(inner);
        }
      }
    }
  });

  it.each([[80, 22], [100, 28], [60, 18], [140, 40]])('fits %ix%i exactly and keeps the key hints visible', (w, h) => {
    const f = render(<PlanApproval plan={bigPlan} routes={routes9} onApprove={() => undefined} onCancel={() => undefined} width={w} height={h} />).lastFrame()!;
    const lines = f.split('\n');
    expect(lines.length).toBeLessThanOrEqual(h);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(w);
    expect(f).toContain('Esc cancel');
    expect(f).toContain('Review plan');
  });

  it('shows the full text of a step by scrolling instead of cutting it off', async () => {
    const { stdin, lastFrame } = render(<PlanApproval plan={bigPlan} routes={routes9} onApprove={() => undefined} onCancel={() => undefined} width={80} height={22} />);
    expect(lastFrame()).not.toContain('END-OF-STEP-1');
    expect(lastFrame()).toMatch(/more lines \(PgDn\)/);
    let sawEnd = false;
    for (let i = 0; i < 20 && !lastFrame()!.includes('third criterion'); i++) {
      stdin.write('\u001b[6~'); // PageDown
      await wait();
      sawEnd ||= lastFrame()!.includes('END-OF-STEP-1');
    }
    expect(sawEnd).toBe(true); // the end of the instructions came into view while scrolling
    expect(lastFrame()).toContain('third criterion'); // and so did the last acceptance criterion
  });

  it('keeps the selected step visible when there are more steps than rows', async () => {
    const { stdin, lastFrame } = render(<PlanApproval plan={bigPlan} routes={routes9} onApprove={() => undefined} onCancel={() => undefined} width={100} height={20} />);
    for (let i = 0; i < 8; i++) {
      stdin.write(KEYS.down);
      await wait();
    }
    expect(lastFrame()).toContain('step 9 of 9');
    expect(lastFrame()).toContain('▸ [x] 9.');
  });

  it('shows the end of the buffer while editing a long instruction', async () => {
    const { stdin, lastFrame } = render(<PlanApproval plan={bigPlan} routes={routes9} onApprove={() => undefined} onCancel={() => undefined} width={80} height={22} />);
    stdin.write('i');
    await wait();
    stdin.write(' TYPED-AT-THE-END');
    await wait();
    expect(lastFrame()).toContain('TYPED-AT-THE-END');
    expect(lastFrame()!.split('\n').length).toBeLessThanOrEqual(22);
  });
});

describe('StatsView', () => {
  const pricing = defaultConfig().pricing;
  const now = Date.now();
  const mkTask = (id: string, cost: number, model: string, ok = true) => ({
    id, startedAt: new Date(now - 60_000).toISOString(), prompt: `prompt ${id}`, overhead: { ...emptyUsage(), costUsd: 0.01 }, ok, totals: { ...emptyUsage(), costUsd: cost + 0.01, inputTokens: 1000, outputTokens: 500 },
    steps: [{ stepId: 's1', title: 't', model, tier: model, attempts: 1, escalated: false, usage: { ...emptyUsage(), costUsd: cost, inputTokens: 100_000, outputTokens: 50_000 }, outcome: 'done' as const }],
  });

  it('shows an empty state', () => {
    expect(render(<StatsView summary={summarize([], { now, pricing })} path="/x/h.json" />).lastFrame()).toContain('No tasks recorded yet');
  });

  it('shows windows, per-model spend, escalations, estimated savings and the priciest tasks', () => {
    const tasks = [mkTask('a', 0.25, 'sonnet'), mkTask('b', 0.05, 'haiku', false)];
    const f = render(<StatsView summary={summarize(tasks, { now, pricing })} path="/x/h.json" width={110} />).lastFrame()!;
    expect(f).toContain('Today');
    expect(f).toContain('Last 7d');
    expect(f).toContain('All time');
    expect(f).toContain('2 tasks');
    expect(f).toContain('sonnet');
    expect(f).toContain('haiku');
    expect(f).toContain('classify · plan · review');
    expect(f).toContain('Escalated 0 of 2 steps');
    expect(f).toContain('Estimated savings');
    expect(f).toContain('vs all-opus');
    expect(f).toContain('prompt a');
    expect(f).toContain('/x/h.json');
  });

  it('shows the account limits with bars and reset times when known', () => {
    const limits = { at: now, windows: { five_hour: { utilization: 0.74, resetsAt: now / 1000 + 8040 }, seven_day: { utilization: 0.18, resetsAt: now / 1000 + 3 * 86400 } } };
    const f = render(<StatsView summary={summarize([], { now, pricing })} limits={limits} nowMs={now} path="p" width={100} />).lastFrame()!;
    expect(f).toContain('Your Claude account');
    expect(f).toContain('5h');
    expect(f).toContain('74%');
    expect(f).toContain('resets in 2h 14m');
    expect(f).toContain('7d');
  });
});

describe('LimitsMeter', () => {
  const now = 1_000_000_000_000;
  const limits = { at: now, windows: { five_hour: { utilization: 0.74 }, seven_day: { utilization: 0.18 } } };
  it('shows both windows, or just the tightest in compact mode', () => {
    const full = render(<LimitsMeter limits={limits} nowMs={now} />).lastFrame()!;
    expect(full).toContain('5h 74%');
    expect(full).toContain('7d 18%');
    const compact = render(<LimitsMeter limits={limits} nowMs={now} compact />).lastFrame()!;
    expect(compact).toContain('5h 74%');
    expect(compact).not.toContain('7d');
  });
  it('marks old readings with ~ and renders nothing without data', () => {
    expect(render(<LimitsMeter limits={limits} nowMs={now + 3_600_000} />).lastFrame()).toContain('~5h');
    expect(render(<LimitsMeter limits={null} nowMs={now} />).lastFrame()).toBe('');
  });
});
