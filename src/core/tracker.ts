import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Classification, Usage } from './types.js';
import { addUsage, emptyUsage } from './types.js';

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

export interface ModelStats {
  model: string;
  steps: number;
  usage: Usage;
}

export interface Stats {
  tasks: number;
  succeeded: number;
  totals: Usage;
  byModel: ModelStats[];
}

export function aggregate(tasks: TaskRecord[]): Stats {
  const byModel = new Map<string, ModelStats>();
  let totals = emptyUsage();
  for (const t of tasks) {
    totals = addUsage(totals, t.totals);
    for (const s of t.steps) {
      const m = byModel.get(s.model) ?? { model: s.model, steps: 0, usage: emptyUsage() };
      m.steps += 1;
      m.usage = addUsage(m.usage, s.usage);
      byModel.set(s.model, m);
    }
  }
  return {
    tasks: tasks.length,
    succeeded: tasks.filter((t) => t.ok).length,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd),
  };
}

/** Append-only task log in a single local JSON file. Never throws into the pipeline. */
export class Tracker {
  constructor(private readonly path: string) {}

  load(): TaskRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<HistoryFile>;
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      // Corrupt file: keep it for inspection and start fresh rather than crash.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return [];
    }
  }

  /** Returns an error message when the record could not be persisted. */
  append(record: TaskRecord): string | null {
    try {
      const tasks = [...this.load(), { ...record, prompt: record.prompt.slice(0, MAX_PROMPT) }].slice(-MAX_TASKS);
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, tasks } satisfies HistoryFile, null, 2));
      renameSync(tmp, this.path);
      return null;
    } catch (e) {
      return `Could not write history to ${this.path}: ${(e as Error).message}`;
    }
  }

  stats(): Stats {
    return aggregate(this.load());
  }
}
