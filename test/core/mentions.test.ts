import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMentions, resolveMentions } from '../../src/core/mentions.js';
import { buildStepPrompt, runStep } from '../../src/core/runner.js';
import { defaultConfig } from '../../src/core/config.js';
import { emptyUsage } from '../../src/core/types.js';
import { makeApp } from '../ui/helpers.js';
import type { RunClaudeFn } from '../../src/core/claude.js';

describe('extractMentions', () => {
  it('finds @paths, trims trailing punctuation and de-duplicates', () => {
    expect(extractMentions('fix @src/a.ts and @src/b.ts, then @src/a.ts.')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(extractMentions('@first.txt is at the start')).toEqual(['first.txt']);
    expect(extractMentions('see (@docs/readme.md)')).toEqual([]); // glued to "(" — not a mention
  });
  it('ignores email addresses and a lone @', () => {
    expect(extractMentions('mail me at a@b.com or @ nobody')).toEqual([]);
  });
});

describe('resolveMentions', () => {
  it('reads referenced project files only, within the project', () => {
    const outer = mkdtempSync(join(tmpdir(), 'smart-men-'));
    const proj = join(outer, 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(outer, 'secret.txt'), 'nope');
    const r = resolveMentions(proj, 'look at @src/a.ts and @missing.ts and @../secret.txt', 10_000);
    expect(r).toEqual([{ path: 'src/a.ts', content: 'export const a = 1;', truncated: false }]);
    expect(resolveMentions(proj, 'no mentions here', 1000)).toEqual([]);
  });
});

describe('referenced files reach the model', () => {
  it('runStep shows referenced files before the step\'s own, without duplicating', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smart-men-'));
    writeFileSync(join(cwd, 'a.ts'), 'AAA');
    writeFileSync(join(cwd, 'b.ts'), 'BBB');
    let prompt = '';
    const run: RunClaudeFn = async (o) => { prompt = o.prompt; return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 }; };
    const step = { id: 's1', title: 't', instructions: 'do', files: ['a.ts', 'b.ts'], acceptance: [] };
    await runStep({
      config: defaultConfig(), cwd, run, route: { tier: 'sonnet', model: 'sonnet', reason: '' }, permissionMode: 'x',
      plan: { summary: 's', features: [], fileStructure: [], steps: [step] }, step, index: 0, total: 1, touchedFiles: [],
      referenced: [{ path: 'a.ts', content: 'AAA', truncated: false }],
    });
    expect(prompt.indexOf('<file path="a.ts">')).toBeLessThan(prompt.indexOf('<file path="b.ts">'));
    expect(prompt.match(/<file path="a\.ts">/g)).toHaveLength(1);
    void buildStepPrompt;
  });

  it('the pipeline passes @-referenced files to the planner and the first coding step, and says so', async () => {
    const seen: { role: string; prompt: string }[] = [];
    const ctx = makeApp({
      complexity: 'large_build',
      executor: async (o) => {
        seen.push({ role: 'executor', prompt: o.prompt });
        return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    writeFileSync(join(ctx.cwd, 'notes.md'), 'REFERENCED-CONTENT');
    const events: string[] = [];
    ctx.bus.subscribe((e) => { if (e.type === 'notice') events.push(e.message); });
    await ctx.pipeline.runTask('build from @notes.md please', { autoApprove: true });
    expect(events.some((m) => /Using 1 referenced file: notes\.md/.test(m))).toBe(true);
    expect(seen[0]?.prompt).toContain('REFERENCED-CONTENT');
    expect(seen[1]?.prompt).not.toContain('REFERENCED-CONTENT'); // only the first step gets them
  });
});
