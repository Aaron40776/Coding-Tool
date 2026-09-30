import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { killTree } from '../../src/core/killTree.js';

const fakeChild = (pid: number | undefined) => {
  const signals: string[] = [];
  return { child: { pid, kill: (s: string) => { signals.push(s); return true; } } as unknown as ChildProcess, signals };
};
const fakeSpawn = () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const proc = Object.assign(new EventEmitter(), { unref: () => undefined });
  const impl = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return proc; }) as never;
  return { impl, calls, proc };
};

describe('killTree', () => {
  it('sends the signal elsewhere', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGTERM', 'linux', sp.impl);
    expect(signals).toEqual(['SIGTERM']);
    expect(sp.calls).toEqual([]);
  });

  it('on Windows ends the whole tree with taskkill', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGTERM', 'win32', sp.impl);
    expect(sp.calls).toEqual([{ cmd: 'taskkill', args: ['/pid', '42', '/T', '/F'] }]);
    expect(signals).toEqual([]);
  });

  it('on Windows falls back to a plain kill when taskkill cannot run', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGKILL', 'win32', sp.impl);
    sp.proc.emit('error', new Error('ENOENT'));
    expect(signals).toEqual(['SIGKILL']);
  });
});
