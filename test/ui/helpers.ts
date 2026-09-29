import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { Tracker } from '../../src/core/tracker.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

export const KEYS = { up: '\u001b[A', down: '\u001b[B', left: '\u001b[D', right: '\u001b[C', enter: '\r', esc: '\u001b', backspace: '\x7f', tab: '\t' };

export const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await wait(20);
  }
  throw new Error('waitFor timed out');
}

const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01, outputTokens: 100 }, sessionId: 's', numTurns: 1, ...over,
});

/** A real Pipeline + EventBus + Tracker wired to a scripted fake Claude. */
export function makeApp(opts: { complexity?: Complexity; executor?: RunClaudeFn; config?: (c: SmartConfig) => void } = {}) {
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (props && 'complexity' in props) return res({ structured: { complexity: opts.complexity ?? 'trivial', needsPlan: false, reason: 'scripted' } });
    if (props && 'steps' in props) {
      return res({ structured: { summary: 'Two steps', steps: [{ title: 'First', instructions: 'do 1', acceptance: ['a'] }, { title: 'Second', instructions: 'do 2', acceptance: [] }] } });
    }
    return opts.executor ? opts.executor(o) : res({ text: 'done' });
  };
  const config = defaultConfig();
  config.verify.auto = false;
  opts.config?.(config);
  const dir = mkdtempSync(join(tmpdir(), 'smart-ui-'));
  const trackerPath = join(dir, 'history.json');
  const tracker = new Tracker(trackerPath);
  const bus = new EventBus();
  const pipeline = new Pipeline(config, bus, dir, { run, tracker, listFiles: () => [], uid: 1000 });
  return { pipeline, bus, tracker, trackerPath, cwd: dir, config, version: '0.0.0-test', permissionMode: 'acceptEdits' };
}
