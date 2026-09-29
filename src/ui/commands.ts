import { isTier } from '../core/router.js';
import type { ModelTier } from '../core/types.js';

export type Command =
  | { kind: 'stats' }
  | { kind: 'dry' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'new' }
  | { kind: 'model'; tier: ModelTier | null }
  | { kind: 'error'; message: string }
  | { kind: 'task'; prompt: string };

/** Parses a line typed into the input box: a slash command or a task. */
export function parseInput(raw: string): Command | null {
  const text = raw.trim();
  if (!text) return null;
  if (!text.startsWith('/')) return { kind: 'task', prompt: text };
  const [name = '', ...rest] = text.slice(1).split(/\s+/);
  switch (name.toLowerCase()) {
    case 'stats':
      return { kind: 'stats' };
    case 'dry':
    case 'dry-run':
      return { kind: 'dry' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'quit':
    case 'exit':
      return { kind: 'quit' };
    case 'new':
    case 'clear':
      return { kind: 'new' };
    case 'model': {
      const arg = (rest[0] ?? '').toLowerCase();
      if (arg === 'auto' || arg === 'off' || arg === '') return { kind: 'model', tier: null };
      return isTier(arg) ? { kind: 'model', tier: arg } : { kind: 'error', message: `Unknown model "${rest[0]}". Use haiku, sonnet, opus or auto.` };
    }
    default:
      return { kind: 'error', message: `Unknown command /${name}. Try /help.` };
  }
}

/** Commands offered by Tab completion and the suggestion line. */
export const COMMANDS: { name: string; help: string }[] = [
  { name: '/stats', help: 'usage history' },
  { name: '/model', help: 'force haiku | sonnet | opus | auto' },
  { name: '/dry', help: 'toggle dry-run' },
  { name: '/new', help: 'fresh conversation' },
  { name: '/help', help: 'show help' },
  { name: '/quit', help: 'exit' },
];

export function matchCommands(draft: string): string[] {
  if (!draft.startsWith('/') || /\s/.test(draft)) return [];
  return COMMANDS.map((c) => c.name).filter((n) => n.startsWith(draft.toLowerCase()));
}

export const HELP_TEXT = [
  'Type a task and press Enter. Commands:',
  '  /stats            show cost history',
  '  /model <tier>     force haiku | sonnet | opus (or "auto" to route)',
  '  /dry              toggle dry-run (classify + plan only)',
  '  /new              start a fresh conversation (forget earlier tasks)',
  '  /help, /quit',
  'Keys: Esc cancel · Tab switch panel · ↑/↓ scroll or select · Ctrl+C quit',
].join('\n');
