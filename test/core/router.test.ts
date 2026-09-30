import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { applyWarmCache, escalate, isTier, modelFor, route, routeRole } from '../../src/core/router.js';
import type { Classification, Complexity } from '../../src/core/types.js';

const cls = (complexity: Complexity): Classification => ({ complexity, needsPlan: false, reason: 'x' });
const cfg = () => defaultConfig();

describe('route', () => {
  it.each([
    ['trivial', 'haiku'],
    ['small_edit', 'sonnet'],
    ['multi_file', 'sonnet'],
    ['large_build', 'sonnet'],
  ] as const)('maps %s to %s by default', (c, tier) => {
    const r = route({ classification: cls(c), text: 'do a thing' }, cfg());
    expect(r.tier).toBe(tier);
    expect(r.model).toBe(tier);
    expect(r.reason).toContain(c);
  });

  it('reads model names from config', () => {
    const c = cfg();
    c.models.sonnet = 'claude-sonnet-custom';
    expect(route({ classification: cls('small_edit'), text: 'x' }, c).model).toBe('claude-sonnet-custom');
    expect(modelFor('opus', c)).toBe('opus');
  });

  it('honours edited complexity rules', () => {
    const c = cfg();
    c.routing.multi_file = 'opus';
    expect(route({ classification: cls('multi_file'), text: 'x' }, c).tier).toBe('opus');
  });

  it('applies keyword rules (case-insensitive) above the complexity map', () => {
    const r = route({ classification: cls('trivial'), text: 'Fix a Race Condition in the queue' }, cfg());
    expect(r.tier).toBe('opus');
    expect(r.reason).toMatch(/keyword "Race Condition"/);
  });

  it('lets a step tier beat keywords, and an override beat everything', () => {
    const args = { classification: cls('trivial'), text: 'architecture review' };
    expect(route({ ...args, step: { tier: 'haiku' } }, cfg()).tier).toBe('haiku');
    expect(route({ ...args, step: { tier: 'haiku' }, override: 'sonnet' }, cfg())).toMatchObject({ tier: 'sonnet', reason: 'forced to sonnet' });
  });

  it('ignores an invalid regex instead of throwing', () => {
    const c = cfg();
    c.routing.keywordRules = [{ match: '(', tier: 'opus' }];
    expect(route({ classification: cls('trivial'), text: 'what is a monad' }, c).tier).toBe('haiku');
  });
});

describe('routeRole', () => {
  it('uses configured planner/classifier tiers', () => {
    expect(routeRole('planner', cfg()).tier).toBe('opus');
    expect(routeRole('classifier', cfg()).tier).toBe('haiku');
  });
  it('lets an override change the planner only', () => {
    expect(routeRole('planner', cfg(), 'sonnet').tier).toBe('sonnet');
    expect(routeRole('classifier', cfg(), 'sonnet').tier).toBe('haiku');
  });
});

describe('escalate', () => {
  it('walks the ladder and stops at the top', () => {
    expect(escalate('haiku', cfg())).toBe('sonnet');
    expect(escalate('sonnet', cfg())).toBe('opus');
    expect(escalate('opus', cfg())).toBeNull();
  });
  it('respects a custom ladder', () => {
    const c = cfg();
    c.escalation.ladder = ['sonnet', 'opus'];
    expect(escalate('haiku', c)).toBeNull();
    expect(escalate('sonnet', c)).toBe('opus');
  });
});

describe('isTier', () => {
  it('validates tier names', () => {
    expect(isTier('opus')).toBe(true);
    expect(isTier('gpt')).toBe(false);
  });
});

describe('applyWarmCache', () => {
  const now = 1_000_000;
  const haikuDecision = () => route({ classification: cls('trivial'), text: 'what is x' }, cfg());

  it('keeps a higher tier while the session cache is warm', () => {
    const d = applyWarmCache(haikuDecision(), { lastTier: 'sonnet', lastCallAt: now - 60_000 }, now, cfg());
    expect(d).toMatchObject({ tier: 'sonnet', model: 'sonnet', source: 'session' });
    expect(d.reason).toContain('kept sonnet');
  });
  it('allows the switch when the cheaper model is warm in this session too', () => {
    const d = applyWarmCache(haikuDecision(), { lastTier: 'opus', lastCallAt: now - 1000, lastCallAtByTier: { haiku: now - 90_000, opus: now - 1000 } }, now, cfg());
    expect(d.tier).toBe('haiku');
    const stale = applyWarmCache(haikuDecision(), { lastTier: 'opus', lastCallAt: now - 1000, lastCallAtByTier: { haiku: now - 400_000 } }, now, cfg());
    expect(stale.tier).toBe('opus');
  });
  it('downgrades normally once the cache has gone cold', () => {
    expect(applyWarmCache(haikuDecision(), { lastTier: 'sonnet', lastCallAt: now - 301_000 }, now, cfg()).tier).toBe('haiku');
  });
  it('never blocks an upgrade', () => {
    const up = route({ classification: cls('multi_file'), text: 'x' }, cfg());
    expect(applyWarmCache(up, { lastTier: 'haiku', lastCallAt: now - 1000 }, now, cfg()).tier).toBe('sonnet');
  });
  it('respects forced models, step choices and keyword rules', () => {
    const forced = route({ classification: cls('trivial'), text: 'x', override: 'haiku' }, cfg());
    expect(applyWarmCache(forced, { lastTier: 'opus', lastCallAt: now }, now, cfg()).tier).toBe('haiku');
    const chosen = route({ classification: cls('trivial'), text: 'x', step: { tier: 'haiku' } }, cfg());
    expect(applyWarmCache(chosen, { lastTier: 'opus', lastCallAt: now }, now, cfg()).tier).toBe('haiku');
  });
  it('does nothing without a session, or when disabled', () => {
    expect(applyWarmCache(haikuDecision(), null, now, cfg()).tier).toBe('haiku');
    const c = cfg();
    c.session.keepWarmTier = false;
    expect(applyWarmCache(haikuDecision(), { lastTier: 'opus', lastCallAt: now }, now, c).tier).toBe('haiku');
  });
});
