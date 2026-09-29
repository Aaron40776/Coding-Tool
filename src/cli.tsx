import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { render } from 'ink';
import pkg from '../package.json' with { type: 'json' };
import { resolveClaudeCommand, runClaude } from './core/claude.js';
import { expandHome, loadConfig } from './core/config.js';
import { EventBus } from './core/events.js';
import { SmartError } from './core/errors.js';
import { createCheckpoints } from './core/checkpoint.js';
import { ConversationStore } from './core/conversation.js';
import { InputHistory } from './core/inputHistory.js';
import { Pipeline } from './core/pipeline.js';
import { isTier } from './core/router.js';
import { initConfig } from './init.js';
import { runPrint } from './print.js';
import { Tracker } from './core/tracker.js';
import { LimitsStore } from './core/usage.js';
import type { ModelTier } from './core/types.js';
import { App } from './ui/App.js';

function parseModel(value: string): ModelTier {
  const v = value.toLowerCase();
  if (!isTier(v)) throw new InvalidArgumentError('use haiku, sonnet or opus (names map to models in smart.config.json)');
  return v;
}

const fail = (message: string, hint?: string): never => {
  process.stderr.write(`smart: ${message}\n${hint ? `${hint}\n` : ''}`);
  process.exit(1);
};

interface Options {
  dryRun?: boolean;
  model?: ModelTier;
  plan: boolean;
  config?: string;
  continue?: boolean;
  print?: boolean;
  outputFormat: 'text' | 'json';
  verbose?: boolean;
  budget?: number;
  review: boolean;
}

const parseFormat = (v: string): 'text' | 'json' => {
  if (v !== 'text' && v !== 'json') throw new InvalidArgumentError('use text or json');
  return v;
};
const parseBudget = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number of dollars');
  return n;
};

/** Read all of stdin (for `echo "task" | smart -p`). */
async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function main() {
  // `smart init [--force]` writes a starter config. Only when it is the whole command line, so a task
  // that merely starts with the word "init" (`smart init the repo`) still runs as a task.
  const argv = process.argv.slice(2);
  if (argv[0] === 'init' && argv.length <= 2 && (argv[1] === undefined || argv[1] === '--force')) {
    const example = fileURLToPath(new URL('../smart.config.example.json', import.meta.url));
    const r = initConfig(process.cwd(), example, argv[1] === '--force');
    process.stdout.write(`${r.message}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  const program = new Command()
    .name('smart')
    .description('Run Claude Code through a router that picks the cheapest capable model for each step.')
    .version(pkg.version)
    .argument('[task...]', 'task to run (omit for interactive mode)')
    .option('--dry-run', 'classify and plan only; show the model chosen per step, run nothing')
    .option('--model <name>', 'force a model tier for every step: haiku | sonnet | opus', parseModel)
    .option('--no-plan', 'skip the planning step and run the task as a single step')
    .option('--config <path>', 'path to a smart.config.json')
    .option('-c, --continue', 'continue the previous conversation in this directory')
    .option('-p, --print', 'headless mode: no UI, progress on stderr, final reply on stdout (reads the task from stdin if none given)')
    .option('--output-format <format>', 'with --print: text (default) or json', parseFormat, 'text')
    .option('--verbose', 'with --print: also stream tool calls to stderr')
    .option('--budget <usd>', 'stop a task once it has cost this many dollars', parseBudget)
    .option('--no-review', 'skip the acceptance review after each step')
    .parse();

  const opts = program.opts<Options>();
  const task = program.args.join(' ').trim();
  const cwd = process.cwd();

  let loaded;
  try {
    loaded = loadConfig(cwd, opts.config);
  } catch (e) {
    return fail((e as Error).message);
  }
  const { config } = loaded;
  const configWarnings = loaded.warnings;
  if (opts.budget) config.limits.maxBudgetUsdPerTask = opts.budget;
  if (!opts.review) config.review.enabled = false;

  const claude = resolveClaudeCommand();
  if (spawnSync(claude.cmd, [...claude.prefix, '--version'], { stdio: 'ignore' }).error) {
    const err = new SmartError('cli_missing', 'The `claude` CLI was not found on your PATH.', 'Install Claude Code (https://docs.claude.com/claude-code), then run `claude` once to log in.');
    return fail(err.message, err.hint);
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!opts.print && !interactive) {
    return fail('an interactive terminal is required (stdin and stdout must be a TTY). Use `smart -p "task"` for scripts and pipes.');
  }

  const trackerPath = expandHome(config.trackerPath);
  const tracker = new Tracker(trackerPath);
  const bus = new EventBus();
  const conversationStore = new ConversationStore(expandHome(config.conversationsPath));
  const previous = opts.continue ? conversationStore.load(cwd) : null;
  const startupNotices = [...configWarnings, ...(opts.continue
    ? [previous ? `Continuing your previous conversation here (${previous.tasks.length} earlier task${previous.tasks.length === 1 ? '' : 's'}).` : 'No previous conversation in this directory; starting a new one.']
    : [])];
  const checkpoints = await createCheckpoints(cwd);
  process.on('exit', () => checkpoints.dispose());
  const limitsStore = new LimitsStore(expandHome(config.limitsPath));
  const pipeline = new Pipeline(config, bus, cwd, { run: runClaude, tracker, conversation: previous ?? undefined, conversationStore, checkpoints, limits: limitsStore.load(), limitsStore });

  if (opts.print) {
    let prompt = task;
    if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
    if (!prompt) return fail('with --print, give a task as an argument or on stdin: smart -p "fix the typo in README"');
    pipeline.forceModel(opts.model ?? null);
    for (const w of configWarnings) process.stderr.write(`smart: warning: ${w}\n`);
    // `kill` / `timeout` / a closed terminal must stop Claude Code too, not orphan it (it would keep editing files and spending money).
    const stop = (code: number) => () => {
      pipeline.cancel();
      checkpoints.dispose();
      process.exit(code);
    };
    process.on('SIGTERM', stop(143));
    process.on('SIGHUP', stop(129));
    const code = await runPrint(pipeline, bus, prompt, { format: opts.outputFormat, verbose: Boolean(opts.verbose), dryRun: opts.dryRun, noPlan: !opts.plan }, { out: process.stdout, err: process.stderr });
    checkpoints.dispose();
    // process.exit() can drop what is still buffered when stdout is a pipe (output past ~64 KB was lost), so flush first.
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    await new Promise<void>((r) => process.stderr.write('', () => r()));
    process.exit(code);
  }

  let exitCode = 0;
  const altScreen = (on: boolean) => process.stdout.write(on ? '\x1b[?1049h\x1b[H' : '\x1b[?1049l');
  altScreen(true);
  const restore = () => altScreen(false);
  process.on('exit', restore);
  process.on('SIGTERM', () => {
    pipeline.cancel();
    process.exit(143);
  });

  const app = render(
    <App
      pipeline={pipeline}
      bus={bus}
      tracker={tracker}
      trackerPath={trackerPath}
      cwd={cwd}
      version={pkg.version}
      permissionMode={config.runner.permissionMode}
      pricing={config.pricing}
      startupNotices={startupNotices}
      inputHistory={new InputHistory(expandHome(config.historyPath))}
      oneShot={Boolean(task)}
      initial={task ? { prompt: task, dryRun: opts.dryRun, noPlan: !opts.plan, model: opts.model ?? null } : { prompt: '', dryRun: opts.dryRun, noPlan: !opts.plan, model: opts.model ?? null }}
      onExit={(ok) => {
        exitCode = ok ? 0 : 1;
      }}
    />,
    // A modest fps cap keeps spinners from redrawing constantly. incrementalRendering is opt-in (SMART_INCREMENTAL=1): see README.
    { exitOnCtrlC: false, incrementalRendering: process.env.SMART_INCREMENTAL === '1', maxFps: 12 },
  );
  await app.waitUntilExit();
  restore();
  process.off('exit', restore);
  process.exit(exitCode);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
