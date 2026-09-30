import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Whether a failed `mkdir` of the lock means "someone holds it, try again". On Windows, creating a directory that another
 * process has just deleted (or is deleting) fails with EPERM/EACCES/EBUSY instead of EEXIST; treating that as "no lock
 * possible" let two sessions run unlocked and lose an update.
 */
export function lockBusy(code: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return code === 'EEXIST' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'));
}

/**
 * Runs `fn` while holding a lock directory next to `file`, so two smart sessions doing read-modify-write on the same
 * JSON file (history, conversations, prompt history) do not overwrite each other's update. `mkdir` is atomic on every
 * platform. A lock older than 10 s is treated as abandoned, and after ~3 s of waiting `fn` runs anyway: a stuck lock
 * must never stop smart from working.
 */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  let held = false;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    for (let waited = 0; waited < 3000; waited += 25) {
      try {
        mkdirSync(lock);
        held = true;
        break;
      } catch (e) {
        if (!lockBusy((e as NodeJS.ErrnoException).code)) break;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
        } catch {
          /* someone else removed it: just try again */
        }
        sleep(25);
      }
    }
  } catch {
    /* no lock possible (read-only dir, ...): fall through and let fn report its own error */
  }
  try {
    return fn();
  } finally {
    if (held) {
      // On Windows a just-created directory can be briefly busy (antivirus, indexer): retry, or every other session waits out the timeout.
      for (let i = 0; i < 20; i++) {
        try {
          rmdirSync(lock);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
          sleep(10);
        }
      }
    }
  }
}

/**
 * Writes `text` so a reader never sees half a file: a uniquely named temp file (two smart sessions must not share one),
 * then a rename. Owner-only permissions, since history and conversations contain your prompts.
 */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Moves an unreadable file aside (`file.corrupt-<time>`) instead of overwriting it on the next save. Never throws. */
export function quarantineCorrupt(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* nothing more to do */
  }
}
