import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, mergeConfig } from '../src/core/config.js';
import { initConfig } from '../src/init.js';

const dir = (p = 'smart-init-') => mkdtempSync(join(tmpdir(), p));

describe('initConfig', () => {
  it('writes a small starter that loads without warnings and changes nothing', () => {
    const d = dir();
    const home = dir('smart-home-');
    const r = initConfig(join(d, 'smart.config.json'));
    expect(r.ok).toBe(true);
    const loaded = loadConfig(d, undefined, home);
    expect(loaded.source).toBe(join(d, 'smart.config.json'));
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual(defaultConfig());
    // Only a few settings, so later default changes still reach you.
    expect(readFileSync(join(d, 'smart.config.json'), 'utf8')).not.toContain('keywordRules');
  });

  it('refuses to overwrite without --force, and overwrites with it', () => {
    const d = dir();
    const target = join(d, 'smart.config.json');
    writeFileSync(target, '{"mine": true}');
    expect(initConfig(target).ok).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"mine": true}');
    expect(initConfig(target, true).ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('"routing"');
  });

  it('creates the folder for a global config, and reports an unwritable target instead of throwing', () => {
    const home = dir('smart-home-');
    expect(initConfig(join(home, '.smart', 'smart.config.json')).ok).toBe(true);
    const file = join(dir(), 'file');
    writeFileSync(file, '');
    expect(initConfig(join(file, 'smart.config.json')).message).toMatch(/Could not write/);
  });
});

describe('loadConfig: your global config, then the project\'s on top', () => {
  const write = (d: string, obj: object) => {
    writeFileSync(join(d, 'smart.config.json'), JSON.stringify(obj));
    return d;
  };
  const globalIn = (home: string, obj: object) => {
    mkdirSync(join(home, '.smart'), { recursive: true });
    write(join(home, '.smart'), obj);
  };

  it('a project file changes only the keys it sets', () => {
    const home = dir('smart-home-');
    globalIn(home, { runner: { permissionMode: 'acceptEdits' }, routing: { optimize: 'cost', planner: 'sonnet' } });
    const project = write(dir(), { routing: { optimize: 'quality' } });
    const { config, sources, source } = loadConfig(project, undefined, home);
    expect(config.routing.optimize).toBe('quality'); // project wins
    expect(config.routing.planner).toBe('sonnet'); // global still applies within the same section
    expect(config.runner.permissionMode).toBe('acceptEdits'); // and in other sections
    expect(sources).toEqual([join(home, '.smart', 'smart.config.json'), join(project, 'smart.config.json')]);
    expect(source).toBe(join(project, 'smart.config.json'));
  });

  it('uses the global file alone when the project has none, and defaults when neither exists', () => {
    const home = dir('smart-home-');
    expect(loadConfig(dir(), undefined, home).source).toBeNull();
    globalIn(home, { review: { enabled: false } });
    expect(loadConfig(dir(), undefined, home).config.review.enabled).toBe(false);
  });

  it('--config replaces the project layer, still on top of the global file', () => {
    const home = dir('smart-home-');
    globalIn(home, { routing: { planner: 'sonnet' } });
    const d = dir();
    writeFileSync(join(d, 'other.json'), JSON.stringify({ limits: { maxPlanSteps: 3 } }));
    const { config } = loadConfig(d, 'other.json', home);
    expect(config.limits.maxPlanSteps).toBe(3);
    expect(config.routing.planner).toBe('sonnet');
  });

  it('names the file an error is in, and warns about risky settings only for the project file', () => {
    const home = dir('smart-home-');
    globalIn(home, { verify: { commands: ['npm test'] } });
    const project = write(dir(), { routing: { planner: 'gpt' } });
    expect(() => loadConfig(project, undefined, home)).toThrow(join(project, 'smart.config.json'));
    const ok = write(dir(), {});
    expect(loadConfig(ok, undefined, home).warnings).toEqual([]); // your own global commands are not a warning
  });

  it('accepts "//" notes and $schema without warning', () => {
    const d = write(dir(), { '//': 'note', $schema: 'x', routing: { '//': 'note', optimize: 'cost' } });
    const { config, warnings } = loadConfig(d, undefined, dir('smart-home-'));
    expect(warnings).toEqual([]);
    expect(config.routing.optimize).toBe('cost');
  });

  it('mergeConfig: objects merge, arrays and null replace', () => {
    expect(mergeConfig({ a: { b: 1, c: [1, 2] }, d: 5 }, { a: { c: [3] }, d: null })).toEqual({ a: { b: 1, c: [3] }, d: null });
  });
});
