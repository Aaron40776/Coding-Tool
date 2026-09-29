import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { defaultExec, detectChecks, nextAttempt, runChecks, tail, type ExecFn } from '../../src/core/verifier.js';

const proj = (pkg?: object) => {
  const d = mkdtempSync(join(tmpdir(), 'smart-ver-'));
  if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  return d;
};

describe('detectChecks', () => {
  it('finds scripts in cheapest-first order', () => {
    const d = proj({ scripts: { test: 'vitest', build: 'tsup', lint: 'eslint .', typecheck: 'tsc', dev: 'x' } });
    expect(detectChecks(d, defaultConfig()).map((c) => c.name)).toEqual(['typecheck', 'lint', 'build', 'test']);
    expect(detectChecks(d, defaultConfig())[0]?.command).toBe('npm run typecheck');
  });
  it('skips the npm placeholder test script', () => {
    const d = proj({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(detectChecks(d, defaultConfig())).toEqual([]);
  });
  it('returns nothing without package.json, with bad JSON, or when auto is off', () => {
    expect(detectChecks(proj(), defaultConfig())).toEqual([]);
    const bad = proj();
    writeFileSync(join(bad, 'package.json'), '{oops');
    expect(detectChecks(bad, defaultConfig())).toEqual([]);
    const c = defaultConfig();
    c.verify.auto = false;
    expect(detectChecks(proj({ scripts: { test: 'x' } }), c)).toEqual([]);
  });
  it('config commands override auto-detection', () => {
    const c = defaultConfig();
    c.verify.commands = ['pytest -q', 'ruff check .'];
    expect(detectChecks(proj({ scripts: { test: 'x' } }), c).map((x) => x.command)).toEqual(['pytest -q', 'ruff check .']);
  });
});

describe('runChecks', () => {
  const cfg = defaultConfig();
  it('skips when there are no checks', async () => {
    expect(await runChecks([], { cwd: '.', config: cfg })).toEqual({ ok: true, skipped: true, ran: [] });
  });
  it('stops at the first failure and reports its trimmed output', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return cmd === 'b' ? { code: 1, output: 'x'.repeat(5000) + 'BOOM' } : { code: 0, output: '' };
    };
    const seen: string[] = [];
    const r = await runChecks([{ name: 'a', command: 'a' }, { name: 'b', command: 'b' }, { name: 'c', command: 'c' }], {
      cwd: '.', config: cfg, exec, onCheck: (c) => seen.push(`${c.command}:${c.ok}`),
    });
    expect(calls).toEqual(['a', 'b']);
    expect(seen).toEqual(['a:true', 'b:false']);
    expect(r.ok).toBe(false);
    expect(r.failure?.output.endsWith('BOOM')).toBe(true);
    expect(r.failure?.output.length).toBeLessThanOrEqual(2001);
  });
  it('passes when everything passes', async () => {
    const r = await runChecks([{ name: 'a', command: 'a' }], { cwd: '.', config: cfg, exec: async () => ({ code: 0, output: '' }) });
    expect(r).toMatchObject({ ok: true, skipped: false });
  });
  it('notes timeouts in the failure output', async () => {
    const r = await runChecks([{ name: 'a', command: 'a' }], { cwd: '.', config: cfg, exec: async () => ({ code: null, output: 'partial', timedOut: true }) });
    expect(r.failure?.output).toMatch(/timed out/);
  });
});

// Portable across sh and cmd.exe: `sleep` does not exist on Windows.
const SLEEP = `node -e "setTimeout(()=>{},30000)"`;

describe('defaultExec (real shell)', () => {
  it('captures output and exit codes', async () => {
    const ok = await defaultExec('echo hi', { cwd: '.', timeoutMs: 5000 });
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.output).toContain('hi');
    const bad = await defaultExec(`node -e "console.error('oops');process.exit(3)"`, { cwd: '.', timeoutMs: 5000 });
    expect(bad.code).toBe(3);
    expect(bad.output).toContain('oops');
  });
  it('times out and kills a long-running command', async () => {
    const t = Date.now();
    const r = await defaultExec(SLEEP, { cwd: '.', timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it('aborts via signal', async () => {
    const ac = new AbortController();
    const p = defaultExec(SLEEP, { cwd: '.', timeoutMs: 60000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const t = Date.now();
    await p;
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('nextAttempt', () => {
  const cfg = defaultConfig(); // retriesPerModel = 1
  it('retries once on the same tier, then escalates, then gives up', () => {
    expect(nextAttempt({ tier: 'sonnet', failuresOnTier: 1 }, cfg)).toEqual({ action: 'retry', tier: 'sonnet' });
    expect(nextAttempt({ tier: 'sonnet', failuresOnTier: 2 }, cfg)).toEqual({ action: 'escalate', from: 'sonnet', tier: 'opus' });
    expect(nextAttempt({ tier: 'opus', failuresOnTier: 2 }, cfg)).toEqual({ action: 'give_up' });
  });
  it('escalates immediately when retriesPerModel is 0', () => {
    const c = defaultConfig();
    c.escalation.retriesPerModel = 0;
    expect(nextAttempt({ tier: 'haiku', failuresOnTier: 1 }, c)).toEqual({ action: 'escalate', from: 'haiku', tier: 'sonnet' });
  });
});

describe('tail', () => {
  it('keeps the end of long output', () => {
    expect(tail('a'.repeat(3000) + 'END').endsWith('END')).toBe(true);
    expect(tail('short')).toBe('short');
  });
});
