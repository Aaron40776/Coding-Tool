import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Classification, Complexity, ModelTier, Plan } from './types.js';

export interface TaskMemory {
  prompt: string;
  complexity?: Complexity;
  /** One-line plan summary, when the task was planned. */
  summary?: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'reverted';
  files: string[];
  /** The last thing the model said, trimmed: this is what "the other one" or "that" usually refers to. */
  reply: string;
  at: string;
}

/** An unfinished task (failed or cancelled after planning) that `/resume` can continue. */
export interface PendingTask {
  prompt: string;
  classification: Classification;
  plan: Plan;
  /** Ids of the plan steps that already finished. */
  doneStepIds: string[];
  at: string;
}

/**
 * One continuous conversation with Claude Code. `sessionId` is the persisted Claude Code session the
 * coding steps resume; `tasks` is a compact memory for the stateless calls (classifier, planner) and
 * the fallback when the native session is gone.
 */
export interface Conversation {
  id: string;
  sessionId: string | null;
  lastTier?: ModelTier;
  lastCallAt?: number;
  lastCallAtByTier?: Partial<Record<ModelTier, number>>;
  tasks: TaskMemory[];
  pending?: PendingTask;
}

export const newConversation = (): Conversation => ({ id: randomUUID(), sessionId: null, tasks: [] });

const MAX_TASKS = 30;
const DETAILED = 5;
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function recordTask(conv: Conversation, memory: TaskMemory): void {
  conv.tasks.push({ ...memory, prompt: clip(memory.prompt, 400), reply: clip(memory.reply, 500), files: memory.files.slice(0, 15) });
  if (conv.tasks.length > MAX_TASKS) conv.tasks.splice(0, conv.tasks.length - MAX_TASKS);
}

/**
 * Compact text of what happened so far, newest tasks in detail and older ones as one line each,
 * capped at `maxChars` (oldest dropped first). Empty string for a new conversation.
 */
export function renderMemory(conv: Conversation, maxChars = 3500): string {
  if (conv.tasks.length === 0) return '';
  const lines = conv.tasks.map((t, i) => {
    const detailed = i >= conv.tasks.length - DETAILED;
    const head = `${i + 1}. User: "${clip(t.prompt, detailed ? 300 : 100)}" → ${t.outcome}`;
    if (!detailed) return head;
    const parts = [head];
    if (t.summary) parts.push(`plan: ${clip(t.summary, 160)}`);
    if (t.files.length) parts.push(`files: ${t.files.slice(0, 8).join(', ')}`);
    if (t.reply) parts.push(`you said: "${clip(t.reply, 300)}"`);
    return parts.join('; ');
  });
  let out = lines.join('\n');
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = lines.join('\n');
  }
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

function validPending(p: unknown): PendingTask | undefined {
  const t = p as Partial<PendingTask> | null | undefined;
  if (!t || typeof t.prompt !== 'string' || !t.plan || !Array.isArray(t.plan.steps) || !t.classification || !Array.isArray(t.doneStepIds)) return undefined;
  return t as PendingTask;
}

interface StoreFile {
  version: 1;
  byDir: Record<string, Conversation & { updatedAt: string }>;
}

/** Remembers the last conversation per project directory so `smart -c` can continue it. */
export class ConversationStore {
  constructor(private readonly path: string) {}

  private read(): StoreFile {
    if (!existsSync(this.path)) return { version: 1, byDir: {} };
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreFile>;
      return { version: 1, byDir: d.byDir && typeof d.byDir === 'object' ? d.byDir : {} };
    } catch {
      // Corrupt file: keep it for inspection rather than silently overwriting it on the next save.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return { version: 1, byDir: {} };
    }
  }

  load(cwd: string): Conversation | null {
    const c = this.read().byDir[cwd];
    if (!c || !Array.isArray(c.tasks)) return null;
    return { id: c.id, sessionId: c.sessionId ?? null, lastTier: c.lastTier, lastCallAt: c.lastCallAt, lastCallAtByTier: c.lastCallAtByTier, tasks: c.tasks, pending: validPending(c.pending) };
  }

  /** Returns an error message when it could not be saved. */
  save(cwd: string, conv: Conversation, now = new Date()): string | null {
    try {
      const file = this.read();
      file.byDir[cwd] = { ...conv, updatedAt: now.toISOString() };
      // Keep the file small: only the 50 most recently used directories.
      const keep = Object.entries(file.byDir).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, 50);
      file.byDir = Object.fromEntries(keep);
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`; // unique: two smart sessions must not share a temp file
      writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
      return null;
    } catch (e) {
      return `Could not save conversation to ${this.path}: ${(e as Error).message}`;
    }
  }
}
