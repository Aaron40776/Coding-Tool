import { describe, expect, it } from 'vitest';
import { undoSummary } from '../../src/core/pipeline/changes.js';

describe('the /undo note', () => {
  it('counts files in plain words', () => {
    expect(undoSummary(1, 0)).toBe('restored 1 file');
    expect(undoSummary(2, 1)).toBe('restored 2 files and removed 1 file');
    expect(undoSummary(0, 3)).toBe('removed 3 files');
    expect(undoSummary(0, 0)).toBe('no files needed changing');
  });
});
