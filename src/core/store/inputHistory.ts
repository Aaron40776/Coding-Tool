import { existsSync, readFileSync } from 'node:fs';
import { withFileLock, writeFileAtomic } from './atomicFile.js';

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
      withFileLock(this.path, () => {
        const all = this.load();
        if (all.at(-1) === t) return;
        all.push(t);
        writeFileAtomic(this.path, JSON.stringify(all.slice(-MAX)));
      });
    } catch {
      /* history is a convenience; ignore write failures */
    }
  }
}
