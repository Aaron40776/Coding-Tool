import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { describeRating } from '../src/rate.js';

describe('describeRating (smart --rate)', () => {
  it('shows the signals, the score, the chosen model and effort, and that no model was called', () => {
    const lines = describeRating('the workers stall intermittently, find the root cause of this concurrency bug', defaultConfig()).join('\n');
    expect(lines).toContain('concurrency');
    expect(lines).toMatch(/Result: (opus|sonnet) · \w+, rated \d\.\d\d, \d+% sure/);
    expect(lines).toContain('no model was called');
    expect(lines).toContain('routing.optimize (balanced now)');
  });

  it('is short for a routine task, truncates a very long request in the header, and reflects the config', () => {
    const cfg = defaultConfig();
    cfg.routing.optimize = 'quality';
    const lines = describeRating(`fix the typo ${'x'.repeat(300)}`, cfg);
    expect(lines[0]!.length).toBeLessThan(120);
    expect(lines.join('\n')).toContain('optimize=quality');
  });
});
