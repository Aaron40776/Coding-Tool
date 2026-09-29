import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartConfig } from './config.js';
import { escalate } from './router.js';
import type { ModelTier } from './types.js';

export interface Check {
  name: string;
  command: string;
}

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut?: boolean;
}

export type ExecFn = (command: string, opts: { cwd: string; signal?: AbortSignal; timeoutMs: number }) => Promise<ExecResult>;

export interface VerifyResult {
  ok: boolean;
  /** True when there was nothing to run. */
  skipped: boolean;
  /** Commands that ran, in order, with their outcome. */
  ran: { command: string; ok: boolean }[];
  /** First failing check, if any. */
  failure?: { command: string; output: string };
}

const OUTPUT_LIMIT = 2000;
/** Keep the end of the output: that is where errors and summaries live. */
export const tail = (s: string, n = OUTPUT_LIMIT): string => (s.length > n ? '…' + s.slice(-n) : s).trim();

/** npm's `npm init` placeholder; running it always fails and says nothing about the code. */
const isPlaceholderTest = (cmd: string): boolean => /no test specified/i.test(cmd);

/** Ordered cheapest-first so a type or lint error fails fast before the slow build/tests. */
const SCRIPT_ORDER = ['typecheck', 'lint', 'build', 'test'] as const;

export function detectChecks(cwd: string, config: SmartConfig): Check[] {
  const { auto, commands } = config.verify;
  if (commands.length > 0) return commands.map((command) => ({ name: command, command }));
  if (!auto) return [];
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    return SCRIPT_ORDER.filter((name) => typeof scripts[name] === 'string' && !isPlaceholderTest(scripts[name]!)).map((name) => ({
      name,
      command: `npm run ${name}`,
    }));
  } catch {
    return [];
  }
}

const KILL_GRACE_MS = 2000;

/** Runs a shell command in its own process group so cancel / timeout kill the whole tree. */
export const defaultExec: ExecFn = (command, { cwd, signal, timeoutMs }) =>
  new Promise<ExecResult>((resolve) => {
    if (signal?.aborted) return resolve({ code: null, output: 'Cancelled.' });
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let output = '';
    let timedOut = false;
    let done = false;
    const append = (c: Buffer) => {
      output = (output + c.toString('utf8')).slice(-OUTPUT_LIMIT * 4);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, output, timedOut });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

export interface VerifyOptions {
  cwd: string;
  config: SmartConfig;
  exec?: ExecFn;
  signal?: AbortSignal;
  onCheck?: (r: { command: string; ok: boolean; output: string }) => void;
}

/** Runs each check in order and stops at the first failure. */
export async function runChecks(checks: Check[], opts: VerifyOptions): Promise<VerifyResult> {
  if (checks.length === 0) return { ok: true, skipped: true, ran: [] };
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.config.verify.timeoutSec * 1000;
  const ran: VerifyResult['ran'] = [];
  for (const check of checks) {
    const res = await exec(check.command, { cwd: opts.cwd, signal: opts.signal, timeoutMs });
    const ok = res.code === 0;
    const output = tail(res.timedOut ? `${res.output}\n[timed out after ${opts.config.verify.timeoutSec}s]` : res.output);
    ran.push({ command: check.command, ok });
    opts.onCheck?.({ command: check.command, ok, output });
    if (!ok) return { ok: false, skipped: false, ran, failure: { command: check.command, output } };
  }
  return { ok: true, skipped: false, ran };
}

export interface AttemptState {
  tier: ModelTier;
  /** Failed attempts so far on the current tier. */
  failuresOnTier: number;
}

export type NextAttempt =
  | { action: 'retry'; tier: ModelTier }
  | { action: 'escalate'; from: ModelTier; tier: ModelTier }
  | { action: 'give_up' };

/**
 * Retry policy after a failed attempt: retry the same model `retriesPerModel` times,
 * then move one tier up the ladder, then give up. Pure, so it is easy to test and tune.
 */
export function nextAttempt(state: AttemptState, config: SmartConfig): NextAttempt {
  if (state.failuresOnTier <= config.escalation.retriesPerModel) return { action: 'retry', tier: state.tier };
  const up = escalate(state.tier, config);
  return up ? { action: 'escalate', from: state.tier, tier: up } : { action: 'give_up' };
}
