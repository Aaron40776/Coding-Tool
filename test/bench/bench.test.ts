import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateCost, renderReport, totalsByVariant, type BenchResult } from '../../bench/report.js';
import { TASKS, VARIANTS } from '../../bench/tasks.js';

const dir = () => mkdtempSync(join(tmpdir(), 'smart-bench-'));
const seed = (d: string, files: Record<string, string>) => {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, '.'), { recursive: true });
    writeFileSync(join(d, f), c);
  }
};
const task = (id: string) => TASKS.find((t) => t.id === id)!;

describe('bench tasks', () => {
  it('have unique ids and every starting state fails its own check (except the read-only question)', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) {
      const d = dir();
      seed(d, t.files ?? {});
      if (t.id === 'trivial-question') expect(t.check(d)).toBe(true);
      else expect(t.check(d), t.id).toBe(false);
    }
  });

  it('pass with a correct solution', () => {
    const a = dir();
    writeFileSync(join(a, 'fizzbuzz.js'), "for (let i=1;i<=15;i++) console.log(i%15===0?'FizzBuzz':i%3===0?'Fizz':i%5===0?'Buzz':i);\n");
    expect(task('fizzbuzz').check(a)).toBe(true);

    const b = dir();
    seed(b, task('fix-bug').files!);
    writeFileSync(join(b, 'add.js'), 'exports.add = (a, b) => a + b;\n');
    expect(task('fix-bug').check(b)).toBe(true);

    const c = dir();
    seed(c, task('rename').files!);
    writeFileSync(join(c, 'lib.js'), 'exports.computeTotal = (items) => items.reduce((a, b) => a + b, 0);\n');
    writeFileSync(join(c, 'main.js'), "const { computeTotal } = require('./lib.js');\nconsole.log(computeTotal([1, 2, 3]));\n");
    expect(task('rename').check(c)).toBe(true);
  });

  it('question task fails when the file is modified', () => {
    const d = dir();
    seed(d, task('trivial-question').files!);
    writeFileSync(join(d, 'util.js'), '// changed\n');
    expect(task('trivial-question').check(d)).toBe(false);
  });
});

describe('bench report', () => {
  const rows: BenchResult[] = [
    { taskId: 'a', variant: 'sonnet', passed: true, costUsd: 0.1, outputTokens: 100, seconds: 10 },
    { taskId: 'a', variant: 'smart', passed: true, costUsd: 0.05, outputTokens: 80, seconds: 12 },
    { taskId: 'b', variant: 'sonnet', passed: false, costUsd: 0.1, outputTokens: 100, seconds: 10, error: 'boom' },
    { taskId: 'b', variant: 'smart', passed: true, costUsd: 0.05, outputTokens: 80, seconds: 12 },
  ];

  it('totals per variant', () => {
    const t = totalsByVariant(rows);
    expect(t.get('sonnet')).toMatchObject({ runs: 2, passed: 1 });
    expect(t.get('smart')?.cost).toBeCloseTo(0.1);
  });

  it('renders a table with cost relative to plain sonnet', () => {
    const md = renderReport(rows, { a: 'Task A' });
    expect(md).toContain('| Task A | sonnet | yes |');
    expect(md).toContain('no (boom)');
    expect(md).toMatch(/smart\s*\| 2\/2 \| \$0\.100 \| 50%/);
  });

  it('estimates a cost range, scaling with tasks and variants', () => {
    const one = estimateCost(1, ['sonnet']);
    const many = estimateCost(6, VARIANTS);
    expect(many.high).toBeGreaterThan(one.high);
    expect(one.low).toBeLessThan(one.high);
  });
});
