import { spawnSync } from 'node:child_process';
import { Command, InvalidArgumentError } from 'commander';
import { render } from 'ink';
import pkg from '../package.json' with { type: 'json' };
import { runClaude } from './core/claude.js';
import { expandHome, loadConfig } from './core/config.js';
import { EventBus } from './core/events.js';
import { SmartError } from './core/errors.js';
import { Pipeline } from './core/pipeline.js';
import { isTier } from './core/router.js';
import { Tracker } from './core/tracker.js';
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
}

async function main() {
  const program = new Command()
    .name('smart')
    .description('Run Claude Code through a router that picks the cheapest capable model for each step.')
    .version(pkg.version)
    .argument('[task...]', 'task to run (omit for interactive mode)')
    .option('--dry-run', 'classify and plan only; show the model chosen per step, run nothing')
    .option('--model <name>', 'force a model tier for every step: haiku | sonnet | opus', parseModel)
    .option('--no-plan', 'skip the planning step and run the task as a single step')
    .option('--config <path>', 'path to a smart.config.json')
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

  if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).error) {
    const err = new SmartError('cli_missing', 'The `claude` CLI was not found on your PATH.', 'Install Claude Code (https://docs.claude.com/claude-code), then run `claude` once to log in.');
    return fail(err.message, err.hint);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return fail('an interactive terminal is required (stdin and stdout must be a TTY).');
  }

  const trackerPath = expandHome(config.trackerPath);
  const tracker = new Tracker(trackerPath);
  const bus = new EventBus();
  const pipeline = new Pipeline(config, bus, cwd, { run: runClaude, tracker });

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
      oneShot={Boolean(task)}
      initial={task ? { prompt: task, dryRun: opts.dryRun, noPlan: !opts.plan, model: opts.model ?? null } : { prompt: '', dryRun: opts.dryRun, noPlan: !opts.plan, model: opts.model ?? null }}
      onExit={(ok) => {
        exitCode = ok ? 0 : 1;
      }}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  restore();
  process.off('exit', restore);
  process.exit(exitCode);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
