import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lockBusy, quarantineCorrupt, withFileLock, writeFileAtomic } from '../../src/core/store/atomicFile.js';
import { projectRelative } from '../../src/core/runner.js';
import { InputHistory } from '../../src/core/store/inputHistory.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'smart-lock-'));

describe('withFileLock', () => {
  it('treats a held lock as busy everywhere, and Windows\' EPERM/EACCES/EBUSY (directory being deleted) as busy only there', () => {
    expect(lockBusy('EEXIST', 'linux')).toBe(true);
    for (const c of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(lockBusy(c, 'win32'), c).toBe(true);
      expect(lockBusy(c, 'linux'), c).toBe(false); // a read-only directory on Linux must not make us wait 3 s
    }
    expect(lockBusy('ENOENT', 'win32')).toBe(false);
    expect(lockBusy(undefined, 'win32')).toBe(false);
  });

  it('runs the function, returns its value and removes the lock', () => {
    const f = join(tmp(), 'x.json');
    expect(withFileLock(f, () => 42)).toBe(42);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('releases the lock when the function throws', () => {
    const f = join(tmp(), 'x.json');
    expect(() => withFileLock(f, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('breaks a lock left behind by a crashed process', () => {
    const f = join(tmp(), 'x.json');
    mkdirSync(`${f}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${f}.lock`, old, old);
    expect(withFileLock(f, () => 'ran')).toBe('ran');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('keeps concurrent smart sessions from losing each other\'s history entries', async () => {
    const file = join(tmp(), 'input-history.json');
    const script = join(tmp(), 'writer.ts');
    const src = fileURLToPath(new URL('../../src/core/store/inputHistory.ts', import.meta.url));
    writeFileSync(script, `import { InputHistory } from ${JSON.stringify(src)};\nconst h = new InputHistory(process.argv[2]!);\nfor (let i = 0; i < 8; i++) h.push(process.argv[3] + '-' + i);\n`);
    const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [tsx, script, file, id], { stdio: 'ignore' });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer ${id} exited ${c}`))));
      p.on('error', reject);
    });
    await Promise.all(['a', 'b', 'c', 'd'].map(run));
    expect(new InputHistory(file).load()).toHaveLength(32);
  }, 60_000);
});

describe('writeFileAtomic / quarantineCorrupt', () => {
  it('creates missing directories, replaces the file whole and leaves no temp files behind', () => {
    const d = tmp();
    const f = join(d, 'deep', 'er', 'x.json');
    writeFileAtomic(f, '{"a":1}');
    writeFileAtomic(f, '{"a":2}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(join(d, 'deep', 'er'))).toEqual(['x.json']);
  });

  it('moves a corrupt file aside and does not throw when there is nothing to move', () => {
    const d = tmp();
    const f = join(d, 'bad.json');
    writeFileSync(f, '{oops');
    quarantineCorrupt(f);
    expect(existsSync(f)).toBe(false);
    expect(readdirSync(d).some((n) => n.startsWith('bad.json.corrupt-'))).toBe(true);
    expect(() => quarantineCorrupt(join(d, 'missing.json'))).not.toThrow();
  });
});

describe('projectRelative', () => {
  it('gives project-relative names for paths Claude reports as real paths, even under a symlinked project directory', () => {
    const real = tmp();
    mkdirSync(join(real, 'src'));
    writeFileSync(join(real, 'src', 'a.ts'), 'x');
    const link = join(tmp(), 'link');
    try {
      symlinkSync(real, link, 'dir');
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    // Claude Code reports the real path; smart was started in the link.
    expect(projectRelative(link, join(real, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(projectRelative(link, 'src/a.ts')).toBe('src/a.ts');
    expect(projectRelative(real, join(real, 'src', 'a.ts'))).toBe('src/a.ts');
  });
});
