import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputHistory } from '../../src/core/store/inputHistory.js';

const path = () => join(mkdtempSync(join(tmpdir(), 'smart-hist-')), 'sub', 'h.json');

describe('InputHistory', () => {
  it('stores prompts across instances, skipping blanks and immediate duplicates', () => {
    const p = path();
    const h = new InputHistory(p);
    h.push('first');
    h.push('  ');
    h.push('second');
    h.push('second');
    expect(new InputHistory(p).load()).toEqual(['first', 'second']);
  });
  it('caps the size and survives a corrupt file', () => {
    const p = path();
    const h = new InputHistory(p);
    for (let i = 0; i < 250; i++) h.push(`p${i}`);
    expect(h.load()).toHaveLength(200);
    expect(h.load().at(-1)).toBe('p249');
    writeFileSync(p, '{nope');
    expect(h.load()).toEqual([]);
    h.push('again');
    expect(h.load()).toEqual(['again']);
  });
  it('never throws on an unwritable path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smart-hist-'));
    writeFileSync(join(dir, 'file'), 'x');
    expect(() => new InputHistory(join(dir, 'file', 'h.json')).push('x')).not.toThrow();
  });
});
