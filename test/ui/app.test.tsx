import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { SmartError } from '../../src/core/errors.js';
import { emptyUsage } from '../../src/core/types.js';
import { App } from '../../src/ui/App.js';
import { KEYS, makeApp, wait, waitFor } from './helpers.js';

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await wait();
  stdin.write(KEYS.enter);
};

describe('App', () => {
  it('shows the idle screen: header, pipeline, panels, input and hints', () => {
    const { lastFrame } = render(<App {...makeApp()} />);
    const f = lastFrame()!;
    expect(f).toContain('smart');
    expect(f).toContain('classify');
    expect(f).toContain('Plan');
    expect(f).toContain('Output');
    expect(f).toContain('What should we build?');
    expect(f).toContain('[model:auto]');
    expect(f).toContain('Enter send');
  });

  it('runs a task end to end and shows classification, routing, output and cost', async () => {
    const executor: RunClaudeFn = async (o) => {
      o.onEvent?.({ kind: 'tool', name: 'Edit', summary: 'Edit src/a.ts', writtenFile: 'src/a.ts' });
      o.onEvent?.({ kind: 'text', text: 'Edited the file.' });
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.05, outputTokens: 200 }, sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, 'fix the typo');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    const f = lastFrame()!;
    expect(f).toContain('> fix the typo');
    expect(f).toContain('Classified as small_edit');
    expect(f).toContain('Sonnet');
    expect(f).toContain('small_edit → sonnet');
    expect(f).toContain('Edit src/a.ts');
    expect(f).toContain('Edited the file.');
    expect(f).toContain('session $0.06');
  });

  it('dry run shows classification, plan and per-step model without executing', async () => {
    const executor = vi.fn<RunClaudeFn>();
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial', executor })} initial={{ prompt: 'what is a monad', dryRun: true }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    const f = lastFrame()!;
    expect(f).toContain('Dry run');
    expect(f).toContain('Haiku');
    expect(f).toContain('trivial → haiku');
    expect(f).toContain('[dry-run]');
    expect(executor).not.toHaveBeenCalled();
    void stdin;
  });

  it('/dry toggles dry-run and /model forces a model, shown as tags', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/dry');
    await waitFor(() => lastFrame()!.includes('[dry-run]'));
    await type(stdin, '/model opus');
    await waitFor(() => lastFrame()!.includes('[model:opus]'));
    await type(stdin, '/model auto');
    await waitFor(() => lastFrame()!.includes('[model:auto]'));
    await type(stdin, '/dry');
    await waitFor(() => !lastFrame()!.includes('[dry-run]'));
  });

  it('shows a chat indicator after a task and /new resets it', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} />);
    expect(lastFrame()).not.toContain('[chat:');
    await type(stdin, 'first task');
    await waitFor(() => lastFrame()!.includes('[chat:1]'));
    await type(stdin, '/new');
    await waitFor(() => lastFrame()!.includes('Started a new conversation'));
    expect(lastFrame()).not.toContain('[chat:');
  });

  it('shows startup notices', async () => {
    const { lastFrame } = render(<App {...makeApp()} startupNotices={['Continuing your previous conversation here (2 earlier tasks).']} />);
    await waitFor(() => lastFrame()!.includes('Continuing your previous conversation'));
  });

  it('warns about unknown commands and shows help', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/bogus');
    await waitFor(() => lastFrame()!.includes('Unknown command /bogus'));
    await type(stdin, '/help');
    await waitFor(() => lastFrame()!.includes('/stats'));
  });

  it('forced --model from the CLI applies to routing', async () => {
    const { lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'x', dryRun: true, model: 'opus' }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    expect(lastFrame()).toContain('forced to opus');
    expect(lastFrame()).toContain('[model:opus]');
  });

  it('Esc cancels a running step', async () => {
    let started = false;
    const executor: RunClaudeFn = (o) =>
      new Promise<ClaudeResult>((_, reject) => {
        started = true;
        o.signal?.addEventListener('abort', () => reject(new SmartError('cancelled', 'Cancelled.')));
      });
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, 'do a thing');
    await waitFor(() => started);
    expect(lastFrame()).toContain('Working');
    stdin.write(KEYS.esc);
    await waitFor(() => lastFrame()!.includes('Step cancelled.'), 4000);
    expect(lastFrame()).toContain('Cancelled.');
    expect(lastFrame()).not.toContain('Working');
  });

  it('shows the plan approval screen and runs only approved steps', async () => {
    const calls: string[] = [];
    const executor: RunClaudeFn = async (o) => {
      calls.push(o.prompt);
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build', executor })} />);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    expect(lastFrame()).toContain('1. First');
    stdin.write(KEYS.down);
    await wait();
    stdin.write(' '); // skip step 2
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('✓ Done'), 4000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('do 1');
    expect(lastFrame()).toContain('1. First');
  });

  it('never renders a frame as tall as the terminal (Ink clears the whole screen when it does, which flickers)', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build' })} />);
    const rows = 30; // ink-testing-library's default stdout has no rows; App falls back to 30
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('✓ Done'), 4000);
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
  });

  it('Esc at the approval screen cancels the task', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build' })} />);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    stdin.write(KEYS.esc);
    await waitFor(() => lastFrame()!.includes('Cancelled.'), 4000);
    expect(lastFrame()).not.toContain('Review plan');
  });

  it('shows /stats history from the tracker and closes with Esc', async () => {
    const ctx = makeApp({ complexity: 'trivial' });
    const { stdin, lastFrame } = render(<App {...ctx} />);
    await type(stdin, 'first task');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    await type(stdin, '/stats');
    await waitFor(() => lastFrame()!.includes('Usage history'));
    expect(lastFrame()).toContain('first task');
    expect(lastFrame()).toContain('haiku');
    stdin.write(KEYS.esc);
    await waitFor(() => !lastFrame()!.includes('Usage history'));
  });

  it('one-shot mode exits with the task result', async () => {
    const onExit = vi.fn();
    render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'quick question' }} oneShot onExit={onExit} />);
    await waitFor(() => onExit.mock.calls.length === 1, 4000);
    expect(onExit).toHaveBeenCalledWith(true);
  });

  it('one-shot mode reports failure', async () => {
    const onExit = vi.fn();
    const executor: RunClaudeFn = async () => {
      throw new SmartError('auth', 'not logged in', 'Run `claude` to log in');
    };
    const { lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} initial={{ prompt: 'x' }} oneShot onExit={onExit} />);
    await waitFor(() => onExit.mock.calls.length === 1, 4000);
    expect(onExit).toHaveBeenCalledWith(false);
    expect(lastFrame()).toContain('not logged in');
    expect(lastFrame()).toContain('Run `claude` to log in');
  });

  it('Tab moves focus between panels', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'x', dryRun: true }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    stdin.write(KEYS.tab);
    await wait();
    stdin.write(KEYS.tab);
    await wait();
    stdin.write(KEYS.esc); // back to input
    await wait();
    expect(lastFrame()).toContain('Type another task…');
  });
});
