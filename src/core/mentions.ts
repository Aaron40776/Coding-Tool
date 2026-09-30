import { gatherFiles, type FileContext } from './runner.js';

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/** Drops sentence punctuation after a mention, but keeps brackets that belong to the path (`app/[id]`, `src/(group)`). */
function trimMention(token: string): string {
  let p = token;
  for (;;) {
    const last = p.at(-1) ?? '';
    if (/[,.;:!?'"]/.test(last)) p = p.slice(0, -1);
    else if (last in PAIRS && count(p, last) > count(p, PAIRS[last]!)) p = p.slice(0, -1); // unbalanced closer: "(see @a.ts)"
    else return p;
  }
}

/** `@path` tokens in a prompt. An `@` glued to a word (an email address) is not a mention. */
export function extractMentions(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const p = trimMention(m[1] ?? '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Contents of the project files the user referenced with @path (only real files inside the project, within the byte budget). */
export function resolveMentions(cwd: string, prompt: string, maxBytes: number): FileContext[] {
  const paths = extractMentions(prompt);
  return paths.length ? gatherFiles(cwd, paths, maxBytes) : [];
}
