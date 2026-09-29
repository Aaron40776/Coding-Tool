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
    const t = text.trim();
    if (!t) return;
    try {
      const all = this.load();
      if (all.at(-1) === t) return;
      all.push(t);
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(all.slice(-MAX)));
      renameSync(tmp, this.path);
    } catch {
      /* history is a convenience; ignore write failures */
    }
  }
}
