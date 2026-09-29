import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX = 200;

/** Prompts you typed before, so Up-arrow works across sessions like a shell. Never throws. */
export class InputHistory {
  constructor(private readonly path: string) {}

  load(): string[] {
    try {
      if (!existsSync(this.path)) return [];
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string').slice(-MAX) : [];
    } catch {
      return [];
    }
  }

  push(text: string): void {
    const t = text.trim().slice(0, 4000); // a pasted megabyte must not be stored 200 times
    if (!t) return;
    try {
      const all = this.load();
      if (all.at(-1) === t) return;
      all.push(t);
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`; // unique: two smart sessions must not share a temp file
      writeFileSync(tmp, JSON.stringify(all.slice(-MAX)), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* history is a convenience; ignore write failures */
    }
  }
}
