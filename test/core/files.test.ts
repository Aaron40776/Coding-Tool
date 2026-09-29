import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
