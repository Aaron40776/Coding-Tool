import type { Variant } from './tasks.js';

export interface BenchResult {
  taskId: string;
  variant: Variant;
  passed: boolean;
  costUsd: number;
  outputTokens: number;
  seconds: number;
  error?: string;
}

/** Very rough per-task cost by variant, only used to warn before spending real money. */
const ROUGH_USD: Record<Variant, number> = { sonnet: 0.08, opus: 0.25, smart: 0.1 };
export const estimateCost = (tasks: number, variants: readonly Variant[]): { low: number; high: number } => {
  const mid = variants.reduce((sum, v) => sum + ROUGH_USD[v], 0) * tasks;
  return { low: mid * 0.5, high: mid * 3 };
};

const usd = (n: number): string => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
const pad = (s: string, n: number): string => s.padEnd(n);

interface Totals { runs: number; passed: number; cost: number; seconds: number; out: number }
export function totalsByVariant(results: BenchResult[]): Map<Variant, Totals> {
  const m = new Map<Variant, Totals>();
  for (const r of results) {
    const t = m.get(r.variant) ?? { runs: 0, passed: 0, cost: 0, seconds: 0, out: 0 };
    t.runs += 1;
    t.passed += r.passed ? 1 : 0;
    t.cost += r.costUsd;
    t.seconds += r.seconds;
    t.out += r.outputTokens;
    m.set(r.variant, t);
  }
  return m;
}

/** Markdown report: one row per task and variant, then totals with each variant's cost relative to plain Sonnet. */
export function renderReport(results: BenchResult[], titles: Record<string, string> = {}): string {
  const lines: string[] = ['| task | variant | pass | cost | time | output tokens |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of results) {
    lines.push(`| ${titles[r.taskId] ?? r.taskId} | ${r.variant} | ${r.passed ? 'yes' : r.error ? `no (${r.error.slice(0, 40)})` : 'no'} | ${usd(r.costUsd)} | ${Math.round(r.seconds)}s | ${r.outputTokens} |`);
  }
  const totals = totalsByVariant(results);
  const base = totals.get('sonnet');
  lines.push('', '| variant | passed | total cost | vs plain sonnet | total time |', '| --- | --- | --- | --- | --- |');
  for (const [variant, t] of totals) {
    const rel = base && base.cost > 0 ? `${((t.cost / base.cost) * 100).toFixed(0)}%` : 'n/a';
    lines.push(`| ${pad(variant, 6)} | ${t.passed}/${t.runs} | ${usd(t.cost)} | ${rel} | ${Math.round(t.seconds)}s |`);
  }
  lines.push('', 'Small samples are noisy: run more than once before drawing conclusions. Costs are what Claude Code reports.');
  return lines.join('\n');
}
