import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildArgs, resolvePermissionMode, runClaude, StreamParser, type ClaudeStreamEvent } from '../../src/core/claude.js';
import { SmartError } from '../../src/core/errors.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('StreamParser', () => {
  it('parses a tool-using run into init/tool/text/progress/result', () => {
    const events = new StreamParser().push(fixture('tool-use.jsonl'));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('init');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('text');
    const tool = events.find((e) => e.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.summary).toMatch(/^Read .*a\.txt/);
    const result = events.find((e) => e.kind === 'result');
    expect(result && result.kind === 'result' && result.result.text).toBe('hello');
    expect(result && result.kind === 'result' && result.result.usage.costUsd).toBeGreaterThan(0);
    expect(result && result.kind === 'result' && result.result.isError).toBe(false);
  });

  it('extracts structured output and hides the StructuredOutput tool', () => {
    const events = new StreamParser().push(fixture('structured.jsonl'));
    expect(events.some((e) => e.kind === 'tool')).toBe(false);
    const r = events.find((e) => e.kind === 'result');
    expect(r && r.kind === 'result' && (r.result.structured as { complexity: string }).complexity).toBeTruthy();
  });

  it('handles lines split across chunks and ignores garbage', () => {
    const p = new StreamParser();
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.5 });
    expect(p.push('not json\n' + line.slice(0, 20))).toEqual([]);
    const out = p.push(line.slice(20) + '\n');
    expect(out).toHaveLength(1);
    expect(p.end()).toEqual([]);
  });

  it('counts each assistant message id once for live progress', () => {
    const msg = (block: object) =>
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [block], usage: { input_tokens: 10, output_tokens: 5 } } });
    const p = new StreamParser();
    const a = p.push(msg({ type: 'thinking' }) + '\n' + msg({ type: 'text', text: 'hi' }) + '\n');
    const progress = a.filter((e): e is Extract<ClaudeStreamEvent, { kind: 'progress' }> => e.kind === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.outputTokens).toBe(5);
  });

  it('flags error results', () => {
    const [ev] = new StreamParser().push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }) + '\n');
    expect(ev && ev.kind === 'result' && ev.result.isError).toBe(true);
  });
});

describe('buildArgs / resolvePermissionMode', () => {
  it('builds headless flags', () => {
    const args = buildArgs({ prompt: 'x', model: 'haiku', cwd: '.', tools: [], systemPrompt: 'sys', jsonSchema: { type: 'object' }, permissionMode: 'acceptEdits', bare: true, maxBudgetUsd: 1, extraArgs: ['--foo'] });
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--system-prompt', 'sys', '--permission-mode', 'acceptEdits', '--bare', '--max-budget-usd', '1', '--foo']));
    expect(args).toContain('--json-schema');
  });

  it('omits --tools when unset', () => {
    expect(buildArgs({ prompt: 'x', model: 'm', cwd: '.' })).not.toContain('--tools');
  });

  it('falls back from bypassPermissions when root', () => {
    expect(resolvePermissionMode('bypassPermissions', 0).mode).toBe('acceptEdits');
    expect(resolvePermissionMode('bypassPermissions', 0).warning).toMatch(/root/);
    expect(resolvePermissionMode('bypassPermissions', 1000)).toEqual({ mode: 'bypassPermissions' });
    expect(resolvePermissionMode('acceptEdits', 0)).toEqual({ mode: 'acceptEdits' });
  });
});

function fakeSpawn(script: (child: FakeChild) => void) {
  return (() => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (sig: string) => {
      child.killed.push(sig);
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => script(child));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}
interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string[];
  kill: (s: string) => boolean;
}

describe('runClaude', () => {
  const base = { prompt: 'hi', model: 'haiku', cwd: '.' };

  it('streams events and resolves with the result', async () => {
    const seen: string[] = [];
    const res = await runClaude({
      ...base,
      onEvent: (e) => seen.push(e.kind),
      spawnImpl: fakeSpawn((c) => {
        c.stdout.write(fixture('tool-use.jsonl'));
        c.emit('close', 0);
      }),
    });
    expect(res.text).toBe('hello');
    expect(seen).toContain('tool');
  });

  it('maps ENOENT to cli_missing', async () => {
    const spawnImpl = fakeSpawn((c) => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    await expect(runClaude({ ...base, spawnImpl })).rejects.toMatchObject({ kind: 'cli_missing' });
  });

  it('maps auth failures', async () => {
    const spawnImpl = fakeSpawn((c) => {
      c.stderr.write('Error: Not logged in. Please run /login');
      c.emit('close', 1);
    });
    await expect(runClaude({ ...base, spawnImpl })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports other failures with stderr', async () => {
    const spawnImpl = fakeSpawn((c) => {
      c.stderr.write('boom');
      c.emit('close', 2);
    });
    const err = await runClaude({ ...base, spawnImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SmartError);
    expect(err.message).toMatch(/boom/);
  });

  it('kills the process and rejects as cancelled on abort', async () => {
    const ac = new AbortController();
    let child!: FakeChild;
    const spawnImpl = fakeSpawn((c) => {
      child = c;
      ac.abort();
    });
    await expect(runClaude({ ...base, signal: ac.signal, spawnImpl })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(child.killed).toContain('SIGTERM');
  });

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runClaude({ ...base, signal: ac.signal, spawnImpl: fakeSpawn(() => undefined) })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
