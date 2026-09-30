import { spawn, type ChildProcess } from 'node:child_process';

type Spawn = typeof spawn;

/**
 * Ends a child process. On Windows `child.kill()` ends only that one process, so anything Claude Code
 * started (a dev server, a test run) would keep running; `taskkill /T` ends the whole tree. Elsewhere it is a plain signal.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', platform: string = process.platform, spawnImpl: Spawn = spawn): void {
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => child.kill(signal))
      .unref();
  } catch {
    child.kill(signal);
  }
}
