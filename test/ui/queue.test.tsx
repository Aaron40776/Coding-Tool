import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { SmartError } from '../../src/core/errors.js';
import { emptyUsage } from '../../src/core/types.js';
import { App } from '../../src/ui/App.js';
import { KEYS, makeApp, wait, waitFor } from './helpers.js';

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await wait();
  stdin.write(KEYS.enter);
  await wait();
};

const ok = (text: string): ClaudeResult => ({ isError: false, subtype: 'success', text, structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1 });

/** An executor that waits until released, so a test can type while a task runs. */
function gated(fail = false) {
  let release: () => void = () => undefined;
  const prompts: string[] = [];
  const executor: RunClaudeFn = async (o) => {
    prompts.push(o.prompt);
    if (prompts.length === 1) {
      await new Promise<void>((r) => { release = r; });
      if (fail) throw new SmartError('internal', 'broke');
    }
    return ok(`reply ${prompts.length}`);
  };
  return { executor, prompts, release: () => release() };
}

describe('typing while a task runs', () => {
  it('queues the next task and starts it when the running one completes', async () => {
    const g = gated();
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor: g.executor })} />);
    await type(stdin, 'make the parser handle empty input');
    await waitFor(() => g.prompts.length === 1);
    expect(lastFrame()).toContain('type the next task to queue it');
    await type(stdin, 'now add tests for it');
    await waitFor(() => lastFrame()!.includes('Queued: "now add tests for it"'));
    expect(lastFrame()).toContain('[queued]');
    g.release();
    await waitFor(() => g.prompts.length === 2);
    expect(g.prompts[1]).toContain('now add tests for it');
    await waitFor(() => (lastFrame()!.match(/✓ Done/g) ?? []).length >= 1 && !lastFrame()!.includes('[queued]'));
  });

  it('read-only commands work while a task runs', async () => {
    const g = gated();
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor: g.executor })} />);
    await type(stdin, 'make the parser handle empty input');
    await waitFor(() => g.prompts.length === 1);
    await type(stdin, '/usage');
    await waitFor(() => lastFrame()!.includes('No account usage seen yet'));
    g.release();
  });

  it('Esc cancels the running task and drops the queued one', async () => {
    const g = gated();
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor: g.executor })} />);
    await type(stdin, 'make the parser handle empty input');
    await waitFor(() => g.prompts.length === 1);
    await type(stdin, 'second task');
    await waitFor(() => lastFrame()!.includes('[queued]'));
    stdin.write(KEYS.esc);
    await waitFor(() => lastFrame()!.includes('Dropped the queued task too'));
    g.release();
    await wait(200);
    expect(g.prompts).toHaveLength(1);
  });

  it('does not start the queued task after a failure, and says how to resend it', async () => {
    const g = gated(true);
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor: g.executor })} />);
    await type(stdin, 'make the parser handle empty input');
    await waitFor(() => g.prompts.length === 1);
    await type(stdin, 'second task');
    await waitFor(() => lastFrame()!.includes('[queued]'));
    g.release();
    await waitFor(() => lastFrame()!.includes('queued task was not started'));
    expect(g.prompts).toHaveLength(1);
  });
});

describe('scrolling', () => {
  it('Page Up and Page Down scroll the output while typing, without switching panels', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    for (let i = 0; i < 4; i++) await type(stdin, '/help'); // plenty of output lines
    stdin.write('\u001b[5~'); // Page Up
    await waitFor(() => /scrolled \d+ up/.test(lastFrame()!));
    stdin.write('\u001b[6~'); // Page Down
    await waitFor(() => !/scrolled \d+ up/.test(lastFrame()!));
    stdin.write('abc'); // the input still has focus
    await waitFor(() => lastFrame()!.includes('> abc'));
  });
});
