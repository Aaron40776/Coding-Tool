import type { SmartConfig } from './config.js';
import type { TaskRecord } from './tracker.js';
import type { ModelTier, Usage } from './types.js';

type Pricing = SmartConfig['pricing'];

/** Cost of `u` at list prices (USD per million tokens): cache reads bill at 10% of input, cache writes at 125%. */
export function tokenCost(u: Usage, p: { input: number; output: number }): number {
  return (u.inputTokens * p.input + u.cacheReadTokens * p.input * 0.1 + u.cacheCreationTokens * p.input * 1.25 + u.outputTokens * p.output) / 1e6;
}

export const billable = (u: Usage): number => u.inputTokens + u.cacheCreationTokens + u.outputTokens;

export interface Period {
  tasks: number;
  ok: number;
  cost: number;
  tokens: number;
}

export interface ModelRow {
  model: string;
  steps: number;
  cost: number;
  tokens: number;
}

export interface Savings {
  /** The single model everything would have run on without smart. */
  vs: ModelTier;
  /** What that would have cost at list prices (estimate). */
  baseline: number;
  /** What it actually cost, including classify/plan/review overhead. */
  actual: number;
  saved: number;
  /** saved / baseline, 0..1 (negative when smart cost more). */
  share: number;
}

export interface Summary {
  today: Period;
  week: Period;
  all: Period;
  byModel: ModelRow[];
  /** Classify + plan + review spend, which plain Claude Code would not have. */
  overhead: number;
  steps: number;
  escalatedSteps: number;
  avgTaskCost: number;
  top: { prompt: string; cost: number; ok: boolean }[];
  savings: Savings[];
}

const empty = (): Period => ({ tasks: 0, ok: 0, cost: 0, tokens: 0 });

export function summarize(tasks: TaskRecord[], opts: { now: number; pricing: Pricing; models?: ModelTier[] }): Summary {
  const now = new Date(opts.now);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = opts.now - 7 * 86_400_000;
  const today = empty();
  const week = empty();
  const all = empty();
  const models = new Map<string, ModelRow>();
  let overhead = 0;
  let steps = 0;
  let escalated = 0;

  const add = (p: Period, t: TaskRecord) => {
    p.tasks += 1;
    p.ok += t.ok ? 1 : 0;
    p.cost += t.totals.costUsd;
    p.tokens += billable(t.totals);
  };
  for (const t of tasks) {
    const at = Date.parse(t.startedAt);
    add(all, t);
    if (at >= weekAgo) add(week, t);
    if (at >= startOfToday) add(today, t);
    overhead += t.overhead.costUsd;
    for (const s of t.steps) {
      if (s.outcome === 'skipped') continue;
      steps += 1;
      escalated += s.escalated ? 1 : 0;
      const row = models.get(s.model) ?? { model: s.model, steps: 0, cost: 0, tokens: 0 };
      row.steps += 1;
      row.cost += s.usage.costUsd;
      row.tokens += billable(s.usage);
      models.set(s.model, row);
    }
  }

  // Estimated savings: the same tokens priced as if every step had run on one model, versus what was really spent.
  // Only tasks that executed steps count. A stronger model might use fewer tokens (or a weaker one more), so this is an estimate.
  const executed = tasks.filter((t) => t.steps.some((s) => s.outcome !== 'skipped'));
  const actual = executed.reduce((n, t) => n + t.totals.costUsd, 0);
  const savings: Savings[] = (opts.models ?? ['sonnet', 'opus']).map((vs) => {
    const baseline = executed.reduce((n, t) => n + t.steps.reduce((m, s) => m + (s.outcome === 'skipped' ? 0 : tokenCost(s.usage, opts.pricing[vs])), 0), 0);
    return { vs, baseline, actual, saved: baseline - actual, share: baseline > 0 ? (baseline - actual) / baseline : 0 };
  });

  return {
    today, week, all,
    byModel: [...models.values()].sort((a, b) => b.cost - a.cost),
    overhead, steps, escalatedSteps: escalated,
    avgTaskCost: all.tasks ? all.cost / all.tasks : 0,
    top: [...tasks].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, 3).map((t) => ({ prompt: t.prompt, cost: t.totals.costUsd, ok: t.ok })),
    savings,
  };
}

export const emptySummary = (pricing: Pricing): Summary => summarize([], { now: Date.now(), pricing });

const money = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(n >= 10 ? 1 : 2)}`);

/** Lines for /cost: what this session spent, by model, and the estimated saving. */
export function costLines(sum: Summary): string[] {
  if (sum.all.tasks === 0) return ['Nothing spent in this session yet.'];
  const steps = sum.byModel.reduce((n, m) => n + m.cost, 0);
  const lines = [
    `This session: ${sum.all.tasks} task${sum.all.tasks === 1 ? '' : 's'} · ${money(sum.all.cost)} (coding ${money(steps)} · classify/plan/review ${money(sum.overhead)})`,
    ...sum.byModel.map((m) => `  ${m.model.padEnd(8)} ${String(m.steps).padStart(3)} step${m.steps === 1 ? ' ' : 's'}  ${money(m.cost)}`),
  ];
  const best = sum.savings.filter((s) => s.baseline > 0).sort((a, b) => b.saved - a.saved)[0];
  if (best) lines.push(`  ≈ ${best.saved >= 0 ? 'saved' : 'extra'} ${money(Math.abs(best.saved))} (${Math.round(Math.abs(best.share) * 100)}%) vs running everything on ${best.vs} (estimate)`);
  return lines;
}
