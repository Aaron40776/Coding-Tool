import type { TaskRecord } from './tracker.js';
import type { Usage } from './types.js';

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
}

const empty = (): Period => ({ tasks: 0, ok: 0, cost: 0, tokens: 0 });

export function summarize(tasks: TaskRecord[], opts: { now: number }): Summary {
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

  return {
    today, week, all,
    byModel: [...models.values()].sort((a, b) => b.cost - a.cost),
    overhead, steps, escalatedSteps: escalated,
    avgTaskCost: all.tasks ? all.cost / all.tasks : 0,
    top: [...tasks].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, 3).map((t) => ({ prompt: t.prompt, cost: t.totals.costUsd, ok: t.ok })),
  };
}

export const emptySummary = (): Summary => summarize([], { now: Date.now() });

const money = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(n >= 10 ? 1 : 2)}`);

/** Lines for /cost: what this session spent, by model. */
export function costLines(sum: Summary): string[] {
  if (sum.all.tasks === 0) return ['Nothing spent in this session yet.'];
  const steps = sum.byModel.reduce((n, m) => n + m.cost, 0);
  return [
    `This session: ${sum.all.tasks} task${sum.all.tasks === 1 ? '' : 's'} · ${money(sum.all.cost)} (coding ${money(steps)} · classify/plan/review ${money(sum.overhead)})`,
    ...sum.byModel.map((m) => `  ${m.model.padEnd(8)} ${String(m.steps).padStart(3)} step${m.steps === 1 ? ' ' : 's'}  ${money(m.cost)}`),
  ];
}
