import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity, type Limits } from '../../src/core/types.js';
import { LimitsStore } from '../../src/core/usage.js';

const NOW = 1_800_000_000_000;

function setup(opts: { complexity?: Complexity; reports?: (number | null)[]; initial?: Limits | null; config?: (c: SmartConfig) => void; store?: LimitsStore } = {}) {
  const models: { role: string; model: string }[] = [];
  const reports = [...(opts.reports ?? [])];
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : props && 'pass' in props ? 'reviewer' : 'executor';
    models.push({ role, model: o.model });
    const next = reports.shift();
    if (next !== undefined && next !== null) o.onEvent?.({ kind: 'limits', windows: { five_hour: { utilization: next, resetsAt: NOW / 1000 + 3600 }, seven_day: { utilization: 0.2 } }, status: 'allowed' });
    const base: ClaudeResult = { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    if (role === 'classifier') return { ...base, structured: { complexity: opts.complexity ?? 'large_build', needsPlan: (opts.complexity ?? 'large_build') === 'large_build', reason: 'r' } };
    if (role === 'planner') return { ...base, structured: { summary: 'P', steps: [{ title: 'A', instructions: 'a', acceptance: [] }, { title: 'B', instructions: 'b', acceptance: [] }] } };
    return base;
  };
  const config = defaultConfig();
  config.verify.auto = false;
  config.review.enabled = false;
  config.routing.large_build = 'opus'; // make routing want opus so the downshift is visible
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, mkdtempSync(join(tmpdir(), 'smart-lim-')), { run, uid: 1000, listFiles: () => [], now: () => new Date(NOW), limits: opts.initial ?? null, limitsStore: opts.store });
  return { pipeline, models, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('account limits in the pipeline', () => {
  it('captures usage windows from any call, emits them, and persists the latest', async () => {
    const store = new LimitsStore(join(mkdtempSync(join(tmpdir(), 'smart-lim-store-')), 'l.json'));
    const t = setup({ complexity: 'small_edit', reports: [0.4], store });
    await t.pipeline.runTask('x');
    const ev = t.of('limits').at(-1)!;
    expect(ev.limits.windows['five_hour']?.utilization).toBe(0.4);
    expect(t.pipeline.accountLimits?.windows['seven_day']?.utilization).toBe(0.2);
    expect(store.load()?.windows['five_hour']?.utilization).toBe(0.4);
  });

  it('starts from the last persisted reading', () => {
    const initial: Limits = { at: NOW - 60_000, windows: { five_hour: { utilization: 0.3 } } };
    expect(setup({ initial }).pipeline.accountLimits).toEqual(initial);
  });

  it('warns once per window when it crosses the warning level, and again only at 95%', async () => {
    const t = setup({ complexity: 'small_edit', reports: [0.5, 0.82, 0.84, 0.96, 0.97] });
    await t.pipeline.runTask('a'); // classify 0.5 (no warn), exec 0.82 (warn)
    await t.pipeline.runTask('b'); // 0.84 (already warned), 0.96 (critical), 0.97 (already)
    const warnings = t.of('notice').filter((n) => /usage limit/.test(n.message));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toContain('5h usage limit is 82% used (resets in 1h 00m)');
    expect(warnings[1]?.message).toContain('96%');
  });

  it('avoids Opus for automatic routing and planning when a window is nearly used up', async () => {
    const t = setup({ initial: { at: NOW, windows: { five_hour: { utilization: 0.93 } } } });
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.models.find((m) => m.role === 'planner')?.model).toBe('sonnet');
    expect(t.models.filter((m) => m.role === 'executor').every((m) => m.model === 'sonnet')).toBe(true);
    expect(t.of('classified')[0]?.route.reason).toContain('5h limit at 93%');
  });

  it('keeps using Opus below the threshold, when disabled, and when the user forced it', async () => {
    const low = setup({ initial: { at: NOW, windows: { five_hour: { utilization: 0.5 } } } });
    await low.pipeline.runTask('build it', { autoApprove: true });
    expect(low.models.find((m) => m.role === 'planner')?.model).toBe('opus');

    const off = setup({ initial: { at: NOW, windows: { five_hour: { utilization: 0.99 } } }, config: (c) => { c.usage.downshiftAt = 0; } });
    await off.pipeline.runTask('build it', { autoApprove: true });
    expect(off.models.filter((m) => m.role === 'executor').every((m) => m.model === 'opus')).toBe(true);

    const forced = setup({ initial: { at: NOW, windows: { five_hour: { utilization: 0.99 } } } });
    forced.pipeline.forceModel('opus');
    await forced.pipeline.runTask('build it', { autoApprove: true });
    expect(forced.models.filter((m) => m.role === 'executor').every((m) => m.model === 'opus')).toBe(true);
  });

  it('describe() summarises the effective settings and the current usage', () => {
    const text = setup({ initial: { at: NOW, windows: { five_hour: { utilization: 0.5 } } } }).pipeline.describe().join('\n');
    expect(text).toContain('Models: haiku=haiku, sonnet=sonnet, opus=opus');
    expect(text).toContain('large_build→opus');
    expect(text).toContain('Escalation: retry 1× per model, then haiku → sonnet → opus');
    expect(text).toContain('Usage guard: avoid Opus at ≥90%, warn at ≥80% (now 5h 50%)');
  });
});
