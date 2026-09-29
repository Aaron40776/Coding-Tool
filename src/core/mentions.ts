import { gatherFiles, type FileContext } from './runner.js';

/** `@path` tokens in a prompt. An `@` glued to a word (an email address) is not a mention. */
export function extractMentions(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const p = (m[1] ?? '').replace(/[,.;:!?)\]}'"]+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Contents of the project files the user referenced with @path (only real files inside the project, within the byte budget). */
export function resolveMentions(cwd: string, prompt: string, maxBytes: number): FileContext[] {
  const paths = extractMentions(prompt);
  return paths.length ? gatherFiles(cwd, paths, maxBytes) : [];
}
