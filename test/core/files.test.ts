import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { projectFiles } from '../../src/core/files.js';

describe('projectFiles (non-git fallback)', () => {
  it('lists files, skipping noise directories and dotfiles, honouring the limit', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-files-'));
    mkdirSync(join(d, 'src'));
    mkdirSync(join(d, 'node_modules'));
    writeFileSync(join(d, 'package.json'), '{}');
    writeFileSync(join(d, 'src', 'a.ts'), '');
    writeFileSync(join(d, 'node_modules', 'x.js'), '');
    writeFileSync(join(d, '.env'), '');
    expect(projectFiles(d).sort()).toEqual(['package.json', 'src/a.ts']);
    expect(projectFiles(d, 1)).toHaveLength(1);
  });
  it('returns an empty list for an empty or missing directory', () => {
    expect(projectFiles(mkdtempSync(join(tmpdir(), 'smart-files-')))).toEqual([]);
    expect(projectFiles('/definitely/not/here')).toEqual([]);
  });
});

import { projectContext } from '../../src/core/files.js';

describe('projectContext', () => {
  it('includes CLAUDE.md and a package.json summary', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-ctx-'));
    writeFileSync(join(d, 'CLAUDE.md'), '# Rules\nAlways use tabs.');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'vitest', build: 'tsup' }, dependencies: { react: '1' }, devDependencies: { vitest: '1' } }));
    const c = projectContext(d);
    expect(c).toContain('Always use tabs.');
    expect(c).toContain('name=demo, type=module');
    expect(c).toContain('scripts: test, build');
    expect(c).toContain('dependencies: react, vitest');
  });
  it('is empty for a bare directory, tolerates bad JSON, and is size-capped', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-ctx-'));
    expect(projectContext(d)).toBe('');
    writeFileSync(join(d, 'package.json'), '{oops');
    expect(projectContext(d)).toBe('');
    writeFileSync(join(d, 'CLAUDE.md'), 'x'.repeat(10_000));
    expect(projectContext(d, 500).length).toBeLessThanOrEqual(520);
  });
});

describe('projectFiles (git)', () => {
  it('skips noise directories and stops at the limit without touching every file', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-pf-'));
    execFileSync('git', ['init', '-q'], { cwd: d });
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'node_modules', 'pkg', 'index.js'), 'x');
    for (let i = 0; i < 10; i++) writeFileSync(join(d, 'src', `f${i}.ts`), 'x');
    execFileSync('git', ['add', '-f', '-A'], { cwd: d }); // even tracked node_modules must not crowd out sources
    const files = projectFiles(d, 4);
    expect(files).toHaveLength(4);
    expect(files.every((f) => f.startsWith('src/'))).toBe(true);
  });
});

