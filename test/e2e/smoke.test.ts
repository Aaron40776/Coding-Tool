import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runClaude } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { EventBus } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { Tracker } from '../../src/core/store/tracker.js';

/**
 * Real end-to-end check against the installed `claude` CLI. It spends a few cents of your usage,
 * so it only runs when you ask for it:  SMART_E2E=1 npm test -- test/e2e
 */
describe.skipIf(!process.env.SMART_E2E)('real claude CLI (SMART_E2E=1)', () => {
  it('runs one tiny task on Haiku: file written, cost tracked, history saved', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smart-e2e-'));
    const trackerPath = join(mkdtempSync(join(tmpdir(), 'smart-e2e-history-')), 'history.json');
    const tracker = new Tracker(trackerPath);
    const config = defaultConfig();
    config.verify.auto = false;
    config.review.enabled = false;
    const pipeline = new Pipeline(config, new EventBus(), cwd, { run: runClaude, tracker });
    pipeline.forceModel('haiku');

    const summary = await pipeline.runTask('Create a file named hello.txt whose entire content is the single word: hi', { autoApprove: true, noPlan: true });

    expect(summary.ok).toBe(true);
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8').trim().toLowerCase()).toContain('hi');
    expect(summary.totals.costUsd).toBeGreaterThan(0);
    const saved = tracker.load();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.totals.costUsd).toBeGreaterThan(0);
    expect(saved[0]?.steps[0]?.tier).toBe('haiku');
  }, 240_000);
});
