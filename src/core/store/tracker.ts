import { existsSync, readFileSync } from 'node:fs';
import type { Classification, Usage } from '../types.js';
import { quarantineCorrupt, withFileLock, writeFileAtomic } from './atomicFile.js';

export type StepOutcome = 'done' | 'failed' | 'cancelled' | 'skipped';

export interface StepRecord {
  stepId: string;
  title: string;
  /** Model name of the final attempt, as passed to Claude Code. */
  model: string;
  tier: string;
  attempts: number;
  escalated: boolean;
  usage: Usage;
  outcome: StepOutcome;
  /** What the rater chose at the start of the step; the learning rule compares it with how the step went. */
  rated?: { tier: string; effort?: string; score: number };
}

export interface TaskRecord {
  id: string;
  startedAt: string;
  prompt: string;
  classification?: Classification;
  /** Cost of the classify + plan calls. */
  overhead: Usage;
  steps: StepRecord[];
  totals: Usage;
  ok: boolean;
}

interface HistoryFile {
  version: 1;
  tasks: TaskRecord[];
}

const MAX_TASKS = 1000;
const MAX_PROMPT = 500;

/** Append-only task log in a single local JSON file. Never throws into the pipeline. */
export class Tracker {
  constructor(private readonly path: string) {}

  load(): TaskRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<HistoryFile>;
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      quarantineCorrupt(this.path); // keep it for inspection and start fresh rather than crash
      return [];
    }
  }

  /** Returns an error message when the record could not be persisted. */
  append(record: TaskRecord): string | null {
    try {
      withFileLock(this.path, () => {
        const tasks = [...this.load(), { ...record, prompt: record.prompt.slice(0, MAX_PROMPT) }].slice(-MAX_TASKS);
        writeFileAtomic(this.path, JSON.stringify({ version: 1, tasks } satisfies HistoryFile, null, 2));
      });
      return null;
    } catch (e) {
      return `Could not write history to ${this.path}: ${(e as Error).message}`;
    }
  }

}
