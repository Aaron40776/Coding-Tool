import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, ClaudeStreamEvent, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { buildStepPrompt, gatherFiles, runStep } from '../../src/core/runner.js';
import { emptyUsage, type Plan, type PlanStep } from '../../src/core/types.js';

const dir = () => mkdtempSync(join(tmpdir(), 'smart-run-'));
const step = (over: Partial<PlanStep> = {}): PlanStep => ({ id: 's1', title: 'Add logic', instructions: 'Create src/logic.js', files: [], acceptance: ['tests pass'], ...over });
const plan = (steps: PlanStep[]): Plan => ({ summary: 'Snake game', features: [], fileStructure: [], steps });

describe('gatherFiles', () => {
  it('reads existing files and skips missing ones', () => {
    const d = dir();
    writeFileSync(join(d, 'a.ts'), 'hello');
    const r = gatherFiles(d, ['a.ts', 'missing.ts'], 1000);
    expect(r).toEqual([{ path: 'a.ts', content: 'hello', truncated: false }]);
  });
  it('enforces the byte budget across files and marks truncation', () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'x'.repeat(10));
    writeFileSync(join(d, 'b'), 'y'.repeat(10));
    const r = gatherFiles(d, ['a', 'b'], 15);
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ content: 'y'.repeat(5), truncated: true });
    expect(gatherFiles(d, ['a', 'b'], 0)).toEqual([]);
  });
  it('refuses paths outside the project (traversal and symlinks)', () => {
    const outer = dir();
    writeFileSync(join(outer, 'secret.txt'), 'top secret');
    const proj = join(outer, 'proj');
    mkdirSync(proj);
    let linked = true;
    try {
      symlinkSync(join(outer, 'secret.txt'), join(proj, 'link.txt'));
    } catch {
      linked = false; // Windows without symlink privilege: still check traversal below
    }
    expect(gatherFiles(proj, ['../secret.txt', join(outer, 'secret.txt'), ...(linked ? ['link.txt'] : [])], 1000)).toEqual([]);
  });
  it('skips binary files and directories', () => {
    const d = dir();
    writeFileSync(join(d, 'bin'), Buffer.from([1, 2, 0, 3]));
    mkdirSync(join(d, 'sub'));
    expect(gatherFiles(d, ['bin', 'sub'], 1000)).toEqual([]);
  });
});

describe('buildStepPrompt', () => {
  const base = { plan: plan([step(), step({ id: 's2' })]), step: step(), index: 0, total: 2, touchedFiles: [], fileContext: [] };
  it('describes the step, goal and acceptance criteria without history', () => {
    const p = buildStepPrompt(base);
    expect(p).toContain('step 1 of 2');
    expect(p).toContain('Project goal: Snake game');
    expect(p).toContain('Create src/logic.js');
    expect(p).toContain('- tests pass');
    expect(p).not.toContain('<failure>');
  });
  it('includes touched files, file contents and retry failure output when present', () => {
    const p = buildStepPrompt({
      ...base, touchedFiles: ['a.js', 'b.js'], fileContext: [{ path: 'a.js', content: 'code', truncated: true }], failure: 'TypeError x',
    });
    expect(p).toContain('a.js, b.js');
    expect(p).toContain('<file path="a.js">\ncode\n[truncated]');
    expect(p).toContain('<failure>\nTypeError x');
  });
  it('uses the user\'s own words for a single-step task, so follow-ups read naturally', () => {
    const p = buildStepPrompt({ ...base, total: 1 });
    expect(p.startsWith('Create src/logic.js')).toBe(true);
    expect(p).not.toContain('Project goal');
    expect(p).not.toContain('Complete this task');
  });
  it('includes conversation memory when given', () => {
    expect(buildStepPrompt({ ...base, memory: '1. User: "make a game" → done' })).toContain('Context from earlier in this conversation');
  });
});

describe('runStep', () => {
  const result = (text: string): ClaudeResult => ({ isError: false, subtype: 'success', text, structured: undefined, usage: { ...emptyUsage(), costUsd: 0.02 }, sessionId: 's', numTurns: 2 });

  it('runs on the routed model with lean flags, streams output and collects touched files', async () => {
    const d = dir();
    writeFileSync(join(d, 'a.ts'), 'existing');
    let seen: Parameters<RunClaudeFn>[0] | undefined;
    const out: string[] = [];
    const run: RunClaudeFn = async (o) => {
      seen = o;
      const evs: ClaudeStreamEvent[] = [
        { kind: 'tool', name: 'Read', summary: `Read ${d}/a.ts` },
        { kind: 'tool', name: 'Edit', summary: 'Edit a.ts', writtenFile: join(d, 'a.ts') },
        { kind: 'tool', name: 'Write', summary: 'Write new.ts', writtenFile: join(d, 'sub/new.ts') },
        { kind: 'text', text: 'done' },
      ];
      evs.forEach((e) => o.onEvent?.(e));
      return result('done');
    };
    const cfg = defaultConfig();
    cfg.limits.maxBudgetUsdPerStep = 0.5;
    const r = await runStep({
      config: cfg, cwd: d, run, route: { tier: 'sonnet', model: 'sonnet', reason: 'x' }, permissionMode: 'acceptEdits',
      plan: plan([step({ files: ['a.ts'] })]), step: step({ files: ['a.ts'] }), index: 0, total: 1, touchedFiles: [],
      onOutput: (k, t) => out.push(`${k}:${t}`),
    });
    expect(seen?.model).toBe('sonnet');
    expect(seen?.permissionMode).toBe('acceptEdits');
    expect(seen?.maxBudgetUsd).toBe(0.5);
    expect(seen?.appendSystemPrompt).toBeTruthy();
    expect(seen?.tools).toBeUndefined();
    expect(seen?.prompt).toContain('existing');
    expect(out).toEqual(['tool:Read a.ts', 'tool:Edit a.ts', 'tool:Write new.ts', 'text:done']);
    expect(r.touched.sort()).toEqual(['a.ts', 'sub/new.ts']);
    expect(r.usage.costUsd).toBe(0.02);
  });

  it('propagates run errors (cancel, auth) untouched', async () => {
    const run: RunClaudeFn = async () => { throw Object.assign(new Error('x'), { kind: 'cancelled' }); };
    await expect(
      runStep({ config: defaultConfig(), cwd: '.', run, route: { tier: 'haiku', model: 'haiku', reason: '' }, permissionMode: 'x', plan: plan([step()]), step: step(), index: 0, total: 1, touchedFiles: [] }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
