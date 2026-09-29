import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { initConfig } from '../src/init.js';

const example = new URL('../smart.config.example.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('initConfig', () => {
  it('writes a config that loads and validates', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-init-'));
    const r = initConfig(d, example);
    expect(r.ok).toBe(true);
    expect(loadConfig(d).source).toBe(join(d, 'smart.config.json'));
  });
  it('refuses to overwrite without --force, and overwrites with it', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-init-'));
    writeFileSync(join(d, 'smart.config.json'), '{"mine": true}');
    expect(initConfig(d, example).ok).toBe(false);
    expect(readFileSync(join(d, 'smart.config.json'), 'utf8')).toBe('{"mine": true}');
    expect(initConfig(d, example, true).ok).toBe(true);
    expect(readFileSync(join(d, 'smart.config.json'), 'utf8')).toContain('"routing"');
  });
  it('reports a missing example or an unwritable directory instead of throwing', () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-init-'));
    expect(initConfig(d, join(d, 'nope.json')).message).toMatch(/Could not read/);
    expect(initConfig(join(d, 'missing', 'dir'), example).message).toMatch(/Could not write/);
  });
});
