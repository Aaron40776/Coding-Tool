import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckpoints, GitCheckpoints, NoCheckpoints } from '../../src/core/checkpoint.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function repo(commit = true): string {
  const d = mkdtempSync(join(tmpdir(), 'smart-git-'));
  sh(d, 'init', '-q');
  sh(d, 'config', 'user.email', 't@t.t');
  sh(d, 'config', 'user.name', 't');
  sh(d, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(d, 'keep.txt'), 'keep\n');
  writeFileSync(join(d, '.gitignore'), 'ignored.log\n');
  if (commit) {
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}

const made: GitCheckpoints[] = [];
afterEach(() => made.splice(0).forEach((c) => c.dispose()));
async function cp(dir: string): Promise<GitCheckpoints> {
  const c = new GitCheckpoints(dir);
  expect(await c.init()).toBe(true);
  made.push(c);
  return c;
}

describe('GitCheckpoints', () => {
  it('is unavailable outside a git repository', async () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-nogit-'));
    const c = new GitCheckpoints(d);
    expect(await c.init()).toBe(false);
    expect(await c.snapshot()).toBeNull();
    expect((await createCheckpoints(d)) instanceof NoCheckpoints).toBe(true);
  });

  it('reports added, modified and deleted files with line counts', async () => {
    const d = repo();
    const c = await cp(d);
    const before = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'one\nTWO\nthree\n'); // 1 changed line + 1 added
    writeFileSync(join(d, 'new.txt'), 'x\ny\n');
    unlinkSync(join(d, 'keep.txt'));
    const after = (await c.snapshot())!;
    const ch = (await c.changes(before, after))!;
    expect(Object.fromEntries(ch.files.map((f) => [f.path, f.status]))).toEqual({ 'a.txt': 'M', 'new.txt': 'A', 'keep.txt': 'D' });
    expect(ch.insertions).toBe(2 + 2);
    expect(ch.deletions).toBe(1 + 1);
    expect(await c.changes(before, before)).toEqual({ files: [], insertions: 0, deletions: 0 });
  });

  it('sees files created any way (e.g. by a shell command), including untracked ones, but not ignored ones', async () => {
    const d = repo();
    const c = await cp(d);
    const before = (await c.snapshot())!;
    mkdirSync(join(d, 'src', 'deep'), { recursive: true });
    writeFileSync(join(d, 'src', 'deep', 'made.js'), 'x');
    writeFileSync(join(d, 'ignored.log'), 'noise');
    const ch = (await c.changes(before, (await c.snapshot())!))!;
    expect(ch.files.map((f) => f.path)).toEqual(['src/deep/made.js']);
  });

  it('never touches the real index, HEAD or working tree state', async () => {
    const d = repo();
    writeFileSync(join(d, 'a.txt'), 'edited\n'); // unstaged edit
    writeFileSync(join(d, 'untracked.txt'), 'u\n');
    const statusBefore = sh(d, 'status', '--porcelain');
    const headBefore = sh(d, 'rev-parse', 'HEAD');
    const c = await cp(d);
    await c.snapshot();
    await c.snapshot();
    expect(sh(d, 'status', '--porcelain')).toBe(statusBefore);
    expect(sh(d, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(sh(d, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('works in a repository with no commits yet', async () => {
    const d = repo(false);
    const c = await cp(d);
    const before = (await c.snapshot())!;
    writeFileSync(join(d, 'fresh.txt'), 'hi');
    const ch = (await c.changes(before, (await c.snapshot())!))!;
    expect(ch.files).toEqual([{ path: 'fresh.txt', status: 'A' }]);
  });

  it('restores modified, deleted and created files (undo)', async () => {
    const d = repo();
    const c = await cp(d);
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'CHANGED\n');
    unlinkSync(join(d, 'keep.txt'));
    mkdirSync(join(d, 'gen', 'inner'), { recursive: true });
    writeFileSync(join(d, 'gen', 'inner', 'file.js'), 'new');
    writeFileSync(join(d, 'ignored.log'), 'stays');
    const end = (await c.snapshot())!;
    const r = await c.restore(start, end);
    expect(r).toEqual({ restored: 2, removed: 1 });
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(d, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(d, 'gen'))).toBe(false); // empty parents are cleaned up too
    expect(existsSync(join(d, 'ignored.log'))).toBe(true); // ignored files are never touched
    expect(await c.snapshot()).toBe(start);
  });

  it('produces a readable unified diff', async () => {
    const d = repo();
    const c = await cp(d);
    const a = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');
    const diff = (await c.diff(a, (await c.snapshot())!))!;
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
  });

  it('works from a subdirectory of the repository', async () => {
    const d = repo();
    mkdirSync(join(d, 'pkg'));
    const c = await cp(join(d, 'pkg'));
    const a = (await c.snapshot())!;
    writeFileSync(join(d, 'pkg', 'x.txt'), 'x');
    const ch = (await c.changes(a, (await c.snapshot())!))!;
    expect(ch.files).toEqual([{ path: 'pkg/x.txt', status: 'A' }]);
  });
});

describe('GitCheckpoints: project directory position', () => {
  it('reports where the project directory sits inside the repository', async () => {
    const d = repo();
    mkdirSync(join(d, 'pkg', 'inner'), { recursive: true });
    expect((await cp(d)).prefix).toBe('');
    expect((await cp(join(d, 'pkg'))).prefix).toBe('pkg');
    expect((await cp(join(d, 'pkg', 'inner'))).prefix).toBe('pkg/inner');
  });
  it('prunes only the empty parent directories of removed files', async () => {
    const d = repo();
    mkdirSync(join(d, 'keepdir'), { recursive: true });
    writeFileSync(join(d, 'keepdir', 'stays.txt'), 's');
    const c = await cp(d);
    const start = (await c.snapshot())!;
    mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(d, 'a', 'b', 'c', 'x.txt'), 'x');
    writeFileSync(join(d, 'a', 'y.txt'), 'y');
    writeFileSync(join(d, 'keepdir', 'new.txt'), 'n');
    await c.restore(start, (await c.snapshot())!);
    expect(existsSync(join(d, 'a'))).toBe(false);
    expect(existsSync(join(d, 'keepdir', 'stays.txt'))).toBe(true);
    expect(existsSync(join(d, 'keepdir', 'new.txt'))).toBe(false);
  });
});
