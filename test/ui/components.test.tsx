import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { CostMeter } from '../../src/ui/components/CostMeter.js';
import { InputBox } from '../../src/ui/components/InputBox.js';
import { OutputLog, toRows, wrapText } from '../../src/ui/components/OutputLog.js';
import { PipelineBar } from '../../src/ui/components/PipelineBar.js';
import { PlanApproval } from '../../src/ui/components/PlanApproval.js';
import { PlanChecklist } from '../../src/ui/components/PlanChecklist.js';
import { StatsView } from '../../src/ui/components/StatsView.js';
import { StepBadge } from '../../src/ui/components/StepBadge.js';
import { fmtCost, fmtTokens } from '../../src/ui/format.js';
import { initialStages } from '../../src/ui/state.js';
import { aggregate } from '../../src/core/tracker.js';
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
    expect(lastFrame()).toContain('(your choice)');
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

describe('StatsView', () => {
  it('shows an empty state and a populated breakdown', () => {
    expect(render(<StatsView stats={aggregate([])} recent={[]} path="/x/h.json" />).lastFrame()).toContain('No tasks recorded yet');
    const task = {
      id: 't1', startedAt: '', prompt: 'make a game', overhead: emptyUsage(), ok: true, totals: { ...emptyUsage(), costUsd: 0.25 },
      steps: [{ stepId: 's1', title: 't', model: 'sonnet', tier: 'sonnet', attempts: 1, escalated: false, usage: { ...emptyUsage(), costUsd: 0.25 }, outcome: 'done' as const }],
    };
    const f = render(<StatsView stats={aggregate([task])} recent={[task]} path="/x/h.json" />).lastFrame()!;
    expect(f).toContain('1 task');
    expect(f).toContain('$0.25');
    expect(f).toContain('sonnet');
    expect(f).toContain('make a game');
    expect(f).toContain('/x/h.json');
  });
});
