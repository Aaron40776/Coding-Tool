import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Runs one command in `cwd` with its output shown; returns the exit code. */
export type RunCommand = (cmd: string, args: string[], cwd: string) => number;

// Through the shell on Windows so `npm` finds npm.cmd. The arguments are fixed strings, never user input.
const run: RunCommand = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;

const versionIn = (root: string): string => {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
};

// `npm ci` installs exactly what package-lock.json says and never rewrites it. Earlier versions ran `npm install`, which
// can rewrite the lockfile and then block `git pull --ff-only`, so a lockfile changed that way is put back first.
const STEPS: { cmd: string; args: string[]; hint: string }[] = [
  { cmd: 'git', args: ['checkout', '--', 'package-lock.json'], hint: 'Check that the folder is a clone of https://github.com/Aaron40776/Smart, then run `smart update` again.' },
  { cmd: 'git', args: ['pull', '--ff-only'], hint: 'If you changed files in this folder, commit or undo them (`git stash`), then run `smart update` again.' },
  { cmd: 'npm', args: ['ci'], hint: 'Check your internet connection, then run `smart update` again.' },
  { cmd: 'npm', args: ['run', 'build'], hint: 'Please report this at https://github.com/Aaron40776/Smart/issues with the output above.' },
];

/** `smart update`: pull the latest version into the folder smart was cloned to, install and rebuild. Returns the exit code. */
export function updateSmart(root: string, exec: RunCommand = run, log: (line: string) => void = (l) => void process.stdout.write(`${l}\n`)): number {
  if (!existsSync(join(root, '.git'))) {
    log(`smart in ${root} was not installed with git, so it cannot update itself. Reinstall it with install.ps1 (see the README).`);
    return 1;
  }
  const before = versionIn(root);
  for (const step of STEPS) {
    log(`> ${step.cmd} ${step.args.join(' ')}`);
    const code = exec(step.cmd, step.args, root);
    if (code !== 0) {
      log(`smart update: \`${step.cmd} ${step.args.join(' ')}\` failed (exit code ${code}). ${step.hint}`);
      return code;
    }
  }
  const after = versionIn(root);
  log(after === before ? `smart ${after} is up to date and rebuilt.` : `Updated smart ${before} → ${after}. See CHANGELOG.md for what changed.`);
  return 0;
}
