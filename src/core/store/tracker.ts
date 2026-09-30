import { readFileSync, statSync } from 'node:fs';
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
  /** The last parse, reused while the file is unchanged: it is read at the start of every task, for /cost and for /stats. */
  private cache: { stamp: string; tasks: TaskRecord[] } | null = null;

  constructor(private readonly path: string) {}

  load(): TaskRecord[] {
    let stamp: string;
    try {
      const st = statSync(this.path);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return [];
    }
    if (this.cache?.stamp === stamp) return [...this.cache.tasks];
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<HistoryFile>;
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      this.cache = { stamp, tasks };
      return [...tasks];
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
        // Compact: up to 1000 tasks with their steps; indentation made the file about 40% bigger to read and write.
        writeFileAtomic(this.path, JSON.stringify({ version: 1, tasks } satisfies HistoryFile));
        this.cache = null;
      });
      return null;
    } catch (e) {
      return `Could not write history to ${this.path}: ${(e as Error).message}`;
    }
  }

}
