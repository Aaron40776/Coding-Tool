import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { buildReviewPrompt, parseReview, reviewStep } from '../../src/core/review.js';
import { emptyUsage, type PlanStep } from '../../src/core/types.js';

const step: PlanStep = { id: 's1', title: 'Game loop', instructions: 'Add a tick loop', files: [], acceptance: ['Snake moves each tick'] };
const files = [{ path: 'src/game.js', content: 'function tick() {}', truncated: false }];
const res = (structured: unknown): ClaudeResult => ({ isError: false, subtype: 'success', text: '', structured, usage: { ...emptyUsage(), costUsd: 0.006 }, sessionId: 's', numTurns: 1 });
const input = (run: RunClaudeFn) => ({ task: 'make a snake game', step, files, config: defaultConfig(), cwd: '.', run });

describe('parseReview', () => {
  it('accepts pass and fail verdicts and trims issues', () => {
    expect(parseReview({ pass: true, issues: [] })).toEqual({ pass: true, issues: [] });
    expect(parseReview({ pass: false, issues: ['  src/game.js: tick() never moves the snake ', ''] })).toEqual({ pass: false, issues: ['src/game.js: tick() never moves the snake'] });
  });
  it('caps issues at five', () => {
    expect(parseReview({ pass: false, issues: Array.from({ length: 9 }, (_, i) => `i${i}`) })?.issues).toHaveLength(5);
  });
  it('treats a fail with nothing to fix as a pass, so it cannot loop pointlessly', () => {
    expect(parseReview({ pass: false, issues: [] })).toEqual({ pass: true, issues: [] });
  });
  it.each([[undefined], [{}], [{ pass: 'yes' }], ['text']])('rejects %j', (bad) => {
    expect(parseReview(bad)).toBeNull();
  });
});

describe('buildReviewPrompt', () => {
  it('includes the request, step, criteria and file contents', () => {
    const p = buildReviewPrompt({ task: 'make a snake game', step, files });
    expect(p).toContain('make a snake game');
    expect(p).toContain('Add a tick loop');
    expect(p).toContain('- Snake moves each tick');
    expect(p).toContain('<file path="src/game.js">');
  });
  it('falls back to the instructions as the criterion when the step has none', () => {
    expect(buildReviewPrompt({ task: 't', step: { ...step, acceptance: [] }, files })).toContain('The request is fulfilled: Add a tick loop');
  });
  it('marks truncated files', () => {
    expect(buildReviewPrompt({ task: 't', step, files: [{ ...files[0]!, truncated: true }] })).toContain('[truncated]');
  });
});

describe('reviewStep', () => {
  it('uses the reviewer model with no tools and a schema, and returns the verdict with usage', async () => {
    let seen: Parameters<RunClaudeFn>[0] | undefined;
    const out = await reviewStep(input(async (o) => { seen = o; return res({ pass: false, issues: ['x'] }); }));
    expect(out).toMatchObject({ kind: 'reviewed', pass: false, issues: ['x'] });
    expect(seen?.model).toBe('haiku');
    expect(seen?.tools).toEqual([]);
    expect(seen?.jsonSchema).toBeTruthy();
    expect(out.usage.costUsd).toBe(0.006);
  });
  it('fails open on malformed output or a generic Claude failure', async () => {
    expect((await reviewStep(input(async () => res({ nope: 1 })))).kind).toBe('unavailable');
    expect((await reviewStep(input(async () => { throw new SmartError('claude', 'boom'); }))).kind).toBe('unavailable');
  });
  it.each(['auth', 'cli_missing', 'cancelled'] as const)('propagates %s errors', async (kind) => {
    await expect(reviewStep(input(async () => { throw new SmartError(kind, 'x'); }))).rejects.toMatchObject({ kind });
  });
  it('honours a configured reviewer model', async () => {
    const cfg = defaultConfig();
    cfg.routing.reviewer = 'sonnet';
    let model = '';
    await reviewStep({ ...input(async (o) => { model = o.model; return res({ pass: true, issues: [] }); }), config: cfg });
    expect(model).toBe('sonnet');
  });
});
