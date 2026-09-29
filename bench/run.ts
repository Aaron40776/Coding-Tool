/**
 * Benchmark: the same tasks through plain `claude -p --model sonnet`, plain `--model opus` and `smart`.
 * Costs real money, so it only prints a plan and an estimate unless you pass --run.
 *
 *   npm run bench                       # show the tasks and the estimated cost, run nothing
 *   npm run bench -- --run              # run everything
 *   npm run bench -- --run --tasks fizzbuzz,fix-bug --variants sonnet,smart
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaude, resolvePermissionMode } from '../src/core/claude.js';
import { defaultConfig } from '../src/core/config.js';
import { EventBus } from '../src/core/events.js';
import { Pipeline } from '../src/core/pipeline.js';
import { estimateCost, renderReport, type BenchResult } from './report.js';
import { TASKS, VARIANTS, type BenchTask, type Variant } from './tasks.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const go = args.includes('--run');
const taskIds = flag('tasks')?.split(',');
const variants = (flag('variants')?.split(',') ?? [...VARIANTS]) as Variant[];
for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`Unknown variant ${v}. Use ${VARIANTS.join(', ')}.`);
const tasks = taskIds ? TASKS.filter((t) => taskIds.includes(t.id)) : TASKS;
if (tasks.length === 0) throw new Error(`No matching tasks. Available: ${TASKS.map((t) => t.id).join(', ')}`);

function freshDir(task: BenchTask): string {
  const dir = mkdtempSync(path.join(tmpdir(), `smart-bench-${task.id}-`));
  for (const [f, c] of Object.entries(task.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  // A git repo lets smart's checkpoints and review work the same way they do for real users.
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  } catch {
    /* git is optional */
  }
  return dir;
}

async function runVariant(task: BenchTask, variant: Variant): Promise<BenchResult> {
  const dir = freshDir(task);
  const started = Date.now();
  const res: BenchResult = { taskId: task.id, variant, passed: false, costUsd: 0, outputTokens: 0, seconds: 0 };
  try {
    if (variant === 'smart') {
      const config = defaultConfig();
      const bus = new EventBus();
      const pipeline = new Pipeline(config, bus, dir, { run: runClaude });
      const summary = await pipeline.runTask(task.prompt, { autoApprove: true });
      res.costUsd = summary.totals.costUsd;
      res.outputTokens = summary.totals.outputTokens;
    } else {
      const perm = resolvePermissionMode('bypassPermissions').mode;
      const r = await runClaude({ prompt: task.prompt, model: variant, cwd: dir, permissionMode: perm });
      res.costUsd = r.usage.costUsd;
      res.outputTokens = r.usage.outputTokens;
    }
    res.passed = task.check(dir);
  } catch (e) {
    res.error = (e as Error).message;
  } finally {
    res.seconds = (Date.now() - started) / 1000;
    if (!process.env.SMART_BENCH_KEEP) rmSync(dir, { recursive: true, force: true });
  }
  return res;
}

async function main(): Promise<void> {
  const est = estimateCost(tasks.length, variants);
  console.log(`Tasks (${tasks.length}): ${tasks.map((t) => t.id).join(', ')}`);
  console.log(`Variants: ${variants.join(', ')}`);
  console.log(`Rough cost estimate: $${est.low.toFixed(2)} to $${est.high.toFixed(2)} of real usage (and a good part of your 5-hour window).`);
  if (!go) {
    console.log('\nNothing was run. Add --run to spend that usage.');
    return;
  }
  const results: BenchResult[] = [];
  for (const task of tasks) {
    for (const variant of variants) {
      process.stderr.write(`running ${task.id} / ${variant} ...\n`);
      const r = await runVariant(task, variant);
      results.push(r);
      process.stderr.write(`  ${r.passed ? 'pass' : 'FAIL'} $${r.costUsd.toFixed(3)} ${Math.round(r.seconds)}s${r.error ? ` (${r.error})` : ''}\n`);
    }
  }
  const md = renderReport(results, Object.fromEntries(tasks.map((t) => [t.id, t.title])));
  console.log(`\n${md}`);
  const out = path.resolve('bench-results.md');
  writeFileSync(out, `${md}\n`);
  console.log(`\nWritten to ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
