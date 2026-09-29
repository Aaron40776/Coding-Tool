import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', 'target']);

/** Compact list of project files (tracked + untracked-not-ignored via git, else a shallow walk). */
export function projectFiles(cwd: string, limit = 80): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean).slice(0, limit);
  } catch {
    return walk(cwd, '', 3, limit);
  }
}

function walk(root: string, rel: string, depth: number, limit: number): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth > 0) out.push(...walk(root, path, depth - 1, limit - out.length));
    } else out.push(path);
  }
  return out.slice(0, limit);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

/**
 * What a planner should know about the project that a file list does not say: the project's own
 * instructions (CLAUDE.md / AGENTS.md) and what `package.json` says about scripts and dependencies.
 */
export function projectContext(cwd: string, maxChars = 3500): string {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(cwd, name);
    try {
      if (existsSync(p)) parts.push(`${name}:\n${clip(readFileSync(p, 'utf8').trim(), 2200)}`);
    } catch {
      /* unreadable: skip */
    }
  }
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; type?: string; scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
      const bits = [`package.json: name=${pkg.name ?? '?'}${pkg.type ? `, type=${pkg.type}` : ''}`];
      if (pkg.scripts) bits.push(`scripts: ${Object.keys(pkg.scripts).join(', ')}`);
      const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      if (deps.length) bits.push(`dependencies: ${deps.slice(0, 25).join(', ')}${deps.length > 25 ? ', …' : ''}`);
      parts.push(bits.join('\n'));
    }
  } catch {
    /* malformed package.json: skip */
  }
  return clip(parts.join('\n\n'), maxChars);
}
