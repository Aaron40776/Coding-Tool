import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamParser } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { route } from '../../src/core/router.js';
import { applyLimitPressure, fmtReset, LimitsStore, pct, pressure, tightest, windowLabel } from '../../src/core/usage.js';
import type { Limits } from '../../src/core/types.js';

const limits = (five: number, seven = 0.1): Limits => ({ at: 1000, windows: { five_hour: { utilization: five, resetsAt: 4_000_000_000 }, seven_day: { utilization: seven } } });
const opus = () => route({ classification: { complexity: 'large_build', needsPlan: true, reason: '' }, text: 'x' }, { ...defaultConfig(), routing: { ...defaultConfig().routing, large_build: 'opus' } });

describe('rate_limit_event parsing', () => {
  it('extracts the 5h and 7d windows from a real-shaped event', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.74, resetsAt: 1790712000 }, seven_day: { utilization: 0.18, resetsAt: 1790996400 } } } });
    const [ev] = new StreamParser().push(line + '\n');
    expect(ev).toEqual({ kind: 'limits', status: 'allowed', windows: { five_hour: { utilization: 0.74, resetsAt: 1790712000 }, seven_day: { utilization: 0.18, resetsAt: 1790996400 } } });
  });
  it('ignores events without usable windows and tolerates odd shapes', () => {
    const p = new StreamParser();
    expect(p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) + '\n')).toEqual([]);
    expect(p.push(JSON.stringify({ type: 'rate_limit_event' }) + '\n')).toEqual([]);
    expect(p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x' }, weird: 5 } } }) + '\n')).toEqual([]);
  });
});

describe('formatting helpers', () => {
  it('formats percentages, labels and reset countdowns', () => {
    expect(pct(0.741)).toBe('74%');
    expect(windowLabel('five_hour')).toBe('5h');
    expect(windowLabel('seven_day')).toBe('7d');
    expect(windowLabel('some_new_window')).toBe('some new window');
    const now = 1_000_000_000_000;
    expect(fmtReset(now / 1000 + 8040, now)).toBe('2h 14m');
    expect(fmtReset(now / 1000 + 45 * 60, now)).toBe('45m');
    expect(fmtReset(now / 1000 + 3 * 86400 + 5 * 3600, now)).toBe('3d 5h');
    expect(fmtReset(now / 1000 - 5, now)).toBe('now');
    expect(fmtReset(undefined, now)).toBe('');
  });
  it('bands pressure and picks the tightest window', () => {
    expect([pressure(0.1), pressure(0.6), pressure(0.85)]).toEqual(['ok', 'warn', 'high']);
    expect(tightest(limits(0.3, 0.9))?.name).toBe('seven_day');
    expect(tightest(null)).toBeNull();
    expect(tightest({ at: 0, windows: {} })).toBeNull();
  });
});

describe('applyLimitPressure', () => {
  it('downshifts automatic opus choices to sonnet near the limit, explaining why', () => {
    const d = applyLimitPressure(opus(), limits(0.92), defaultConfig());
    expect(d).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
    expect(d.reason).toContain('5h limit at 92%');
  });
  it('leaves opus alone below the threshold, and when disabled', () => {
    expect(applyLimitPressure(opus(), limits(0.5), defaultConfig()).tier).toBe('opus');
    const c = defaultConfig();
    c.usage.downshiftAt = 0;
    expect(applyLimitPressure(opus(), limits(0.99), c).tier).toBe('opus');
    expect(applyLimitPressure(opus(), null, defaultConfig()).tier).toBe('opus');
  });
  it('never overrides a forced model or the user\'s per-step choice, and only affects opus', () => {
    const forced = route({ classification: { complexity: 'trivial', needsPlan: false, reason: '' }, text: 'x', override: 'opus' }, defaultConfig());
    expect(applyLimitPressure(forced, limits(0.99), defaultConfig()).tier).toBe('opus');
    const chosen = route({ classification: { complexity: 'trivial', needsPlan: false, reason: '' }, text: 'x', step: { tier: 'opus' } }, defaultConfig());
    expect(applyLimitPressure(chosen, limits(0.99), defaultConfig()).tier).toBe('opus');
    const sonnet = route({ classification: { complexity: 'multi_file', needsPlan: false, reason: '' }, text: 'x' }, defaultConfig());
    expect(applyLimitPressure(sonnet, limits(0.99), defaultConfig()).tier).toBe('sonnet');
  });
});

describe('LimitsStore', () => {
  it('round-trips, and tolerates missing, corrupt and unwritable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smart-lim-'));
    const s = new LimitsStore(join(dir, 'sub', 'l.json'));
    expect(s.load()).toBeNull();
    s.save(limits(0.5));
    expect(s.load()).toEqual(limits(0.5));
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(new LimitsStore(join(dir, 'bad.json')).load()).toBeNull();
    writeFileSync(join(dir, 'file'), 'x');
    expect(() => new LimitsStore(join(dir, 'file', 'l.json')).save(limits(0.1))).not.toThrow();
  });
});

describe('expired windows', () => {
  it('ignores a window that has already reset (stale limits.json) for routing and warnings', () => {
    const now = 1_800_000_000_000;
    const stale = { at: 0, windows: { five_hour: { utilization: 0.97, resetsAt: now / 1000 - 3600 }, seven_day: { utilization: 0.2, resetsAt: now / 1000 + 86400 } } };
    expect(tightest(stale, now)?.name).toBe('seven_day');
    expect(tightest({ at: 0, windows: { five_hour: { utilization: 0.97, resetsAt: now / 1000 - 1 } } }, now)).toBeNull();
    expect(tightest({ at: 0, windows: { five_hour: { utilization: 0.97 } } }, now)?.name).toBe('five_hour'); // no reset time known: keep it
  });
});
