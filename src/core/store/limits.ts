import { existsSync, readFileSync } from 'node:fs';
import type { Limits } from '../types.js';
import { writeFileAtomic } from './atomicFile.js';

/** Last-seen account limits, kept between runs so the header is not empty before the first call. Never throws. */
export class LimitsStore {
  constructor(private readonly path: string) {}

  load(): Limits | null {
    try {
      if (!existsSync(this.path)) return null;
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Limits>;
      if (!d || typeof d.at !== 'number' || typeof d.windows !== 'object' || d.windows === null) return null;
      return { windows: d.windows, status: d.status, at: d.at };
    } catch {
      return null;
    }
  }

  save(limits: Limits): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(limits));
    } catch {
      /* a convenience only */
    }
  }
}
