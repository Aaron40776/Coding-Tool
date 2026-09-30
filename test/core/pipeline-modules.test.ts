import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { AccountLimits } from '../../src/core/pipeline/limits.js';
import { plannerDownshift, sessionTooBig } from '../../src/core/pipeline/session.js';
import { forcedClassification, selectChecks, shouldReview, stepBudget } from '../../src/core/pipeline/steps.js';
import { limitError } from '../../src/core/errors.js';
import { newConversation } from '../../src/core/store/conversation.js';

describe('pipeline/steps', () => {
  const c = defaultConfig();
  const checks = [{ name: 'lint', command: 'npm run lint' }, { name: 'test', command: 'npm run test' }];

  it('selectChecks holds tests back until the last plan step', () => {
    expect(selectChecks(checks, false, c)).toEqual({ checks: [checks[0]], deferred: true });
    expect(selectChecks(checks, true, c)).toEqual({ checks, deferred: false });
    expect(selectChecks([checks[0]!], false, c).deferred).toBe(false);
  });

  it('stepBudget: the smaller of the step cap and what is left, never below a cent', () => {
    const cfg = defaultConfig();
    expect(stepBudget(cfg, 0)).toBeNull();
    cfg.limits.maxBudgetUsdPerTask = 1;
    expect(stepBudget(cfg, 0.25)).toBe(0.75);
    expect(stepBudget(cfg, 2)).toBe(0.01);
    cfg.limits.maxBudgetUsdPerStep = 0.5;
    expect(stepBudget(cfg, 0.25)).toBe(0.5);
  });

  it('shouldReview skips questions, empty steps and a lone easy edit', () => {
    const small = { complexity: 'small_edit' as const, needsPlan: false, reason: '' };
    expect(shouldReview(c, { ...small, complexity: 'trivial' }, 1, 0, ['a'])).toBe(false);
    expect(shouldReview(c, small, 2, 1, [])).toBe(false);
    expect(shouldReview(c, { ...small, difficulty: 'easy' }, 1, 0, ['a'])).toBe(false);
    expect(shouldReview(c, small, 1, 0, ['a'])).toBe(true);
    expect(shouldReview(c, small, 1, 2, ['a'])).toBe(false); // a check already gates it
    expect(forcedClassification('opus').fallback).toBe(true);
  });
});

describe('pipeline/session', () => {
  it('sessionTooBig only past the limit and with a session', () => {
    const c = defaultConfig();
    const conv = { ...newConversation(), sessionId: 's', contextTokens: 90_000 };
    expect(sessionTooBig(conv, c)).toBe(90_000);
    expect(sessionTooBig({ ...conv, contextTokens: 10_000 }, c)).toBeNull();
    expect(sessionTooBig({ ...conv, sessionId: null }, c)).toBeNull();
  });

  it('plannerDownshift plans with Sonnet near a usage limit', () => {
    const c = defaultConfig();
    const big = { complexity: 'large_build' as const, needsPlan: true, reason: '' };
    expect(plannerDownshift(big, 0.7, null, c)).toBeNull();
    const nearly = { windows: { five_hour: { utilization: 0.95 } }, at: Date.now() };
    expect(plannerDownshift(big, 0.7, nearly, c)).toBe('sonnet');
  });
});

describe('pipeline/limits', () => {
  it('warns once per window and level, and names the reset in a limit message', () => {
    const bus = new EventBus();
    const events: SmartEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const now = 1_000_000_000_000;
    const l = new AccountLimits(defaultConfig(), bus, () => now, null);
    const w = { five_hour: { utilization: 0.85, resetsAt: now / 1000 + 3600 } };
    l.observe(w);
    l.observe(w);
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1);
    expect(l.message(limitError('usage limit reached'))).toMatch(/\(resets in 1h 00m\)$/);
  });
});
