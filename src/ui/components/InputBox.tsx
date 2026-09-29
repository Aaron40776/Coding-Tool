import { Box, Text, useInput } from 'ink';
import { useLive } from '../useLive.js';
import { ACCENT } from '../theme.js';

export interface InputBoxProps {
  onSubmit: (text: string) => void;
  active: boolean;
  /** Small tags shown inside the box, e.g. "dry-run". */
  tags?: string[];
  placeholder?: string;
  /** Text shown instead of the input while a task runs. */
  busyText?: string;
  /** Total width of the box; the text scrolls horizontally instead of wrapping (a wrapped box would grow the layout). */
  width?: number;
  /** Earlier prompts (oldest first) for the Up arrow. */
  initialHistory?: string[];
  /** Called with the current text on every change, e.g. to show command suggestions. */
  onDraft?: (draft: string) => void;
  /** Slash commands that Tab completes. */
  completions?: string[];
  /** Project files that Tab completes after an `@`. */
  files?: string[];
}

interface Buf {
  value: string;
  cursor: number;
  history: string[];
  histIdx: number | null;
}

const withValue = (b: Buf, value: string, cursor = value.length): Buf => ({ ...b, value, cursor });

/** Claude-Code-style rounded input with a block cursor, history, and basic line editing. */
/** The slice of `value` that fits in `avail` cells with the cursor visible; `…` marks hidden text on the left. */
export function windowText(value: string, cursor: number, avail: number): { before: string; at: string; after: string } {
  if (avail < 4 || value.length + 1 <= avail) return { before: value.slice(0, cursor), at: value.slice(cursor, cursor + 1) || ' ', after: value.slice(cursor + 1) };
  const start = Math.max(0, Math.min(cursor - Math.floor(avail * 0.7), value.length + 1 - avail));
  let seg = value.slice(start, start + avail);
  if (start > 0) seg = `…${seg.slice(1)}`;
  const ci = Math.min(cursor - start, seg.length);
  return { before: seg.slice(0, ci), at: seg.slice(ci, ci + 1) || ' ', after: seg.slice(ci + 1) };
}

const commonPrefix = (xs: string[]): string => xs.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); }, xs[0] ?? '');

/** Files matching the `@word` being typed at the end of `text`, best matches first (prefix before substring). */
export function matchFiles(text: string, files: string[], limit = 50): { prefix: string; matches: string[] } | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const low = prefix.toLowerCase();
  const starts = files.filter((f) => f.toLowerCase().startsWith(low));
  const rest = files.filter((f) => !f.toLowerCase().startsWith(low) && f.toLowerCase().includes(low));
  return { prefix, matches: [...starts, ...rest].slice(0, limit) };
}

export function InputBox({ onSubmit, active, tags = [], placeholder, busyText, width, initialHistory, onDraft, completions, files }: InputBoxProps) {
  const [get, set0] = useLive<Buf>({ value: '', cursor: 0, history: initialHistory ?? [], histIdx: null });
  const set = (u: Buf | ((p: Buf) => Buf)) => {
    set0(u);
    onDraft?.(get().value);
  };

  useInput(
    (input, key) => {
      const b = get();
      if (key.return && (key.meta || key.shift || (b.cursor === b.value.length && b.value.endsWith('\\')))) {
        // Alt/Shift+Enter, or a trailing backslash then Enter, adds a line instead of sending.
        const head = b.value.slice(0, b.cursor).replace(/\\$/, '');
        set(withValue(b, `${head}\n${b.value.slice(b.cursor)}`, head.length + 1));
      } else if (key.return) {
        const text = b.value.trim();
        if (!text) return;
        set({ value: '', cursor: 0, history: [...b.history, text], histIdx: null });
        onSubmit(text);
      } else if (key.tab) {
        const at = files ? matchFiles(b.value.slice(0, b.cursor), files) : null;
        if (at && at.matches.length > 0) {
          const head = b.value.slice(0, b.cursor - at.prefix.length);
          const done = at.matches.length === 1 ? `${at.matches[0]} ` : commonPrefix(at.matches);
          if (done.length >= at.prefix.length) set(withValue(b, head + done + b.value.slice(b.cursor), (head + done).length));
        } else if (completions && b.value.startsWith('/') && !/\s/.test(b.value)) {
          const m = completions.filter((c) => c.startsWith(b.value.toLowerCase()));
          if (m.length === 1) set(withValue(b, `${m[0]} `));
          else if (m.length > 1) set(withValue(b, commonPrefix(m)));
        }
      } else if (key.upArrow) {
        if (b.history.length === 0) return;
        const i = b.histIdx === null ? b.history.length - 1 : Math.max(0, b.histIdx - 1);
        set({ ...withValue(b, b.history[i] ?? ''), histIdx: i });
      } else if (key.downArrow) {
        if (b.histIdx === null) return;
        const i = b.histIdx + 1;
        set(i >= b.history.length ? { ...withValue(b, ''), histIdx: null } : { ...withValue(b, b.history[i] ?? ''), histIdx: i });
      } else if (key.leftArrow) set({ ...b, cursor: Math.max(0, b.cursor - 1) });
      else if (key.rightArrow) set({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) });
      else if (key.home || (key.ctrl && input === 'a')) set({ ...b, cursor: 0 });
      else if (key.end || (key.ctrl && input === 'e')) set({ ...b, cursor: b.value.length });
      else if (key.ctrl && input === 'u') set(withValue(b, b.value.slice(b.cursor), 0));
      else if (key.ctrl && input === 'w') {
        const before = b.value.slice(0, b.cursor).replace(/\S+\s*$/, '');
        set(withValue(b, before + b.value.slice(b.cursor), before.length));
      } else if (key.backspace || key.delete) {
        if (b.cursor > 0) set(withValue(b, b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), b.cursor - 1));
      } else if (input && !key.ctrl && !key.meta && !key.escape && !key.pageUp && !key.pageDown) {
        // Pasted text keeps its line breaks but never submits: trailing newlines are dropped.
        const clean = input.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        if (!clean) return;
        set(withValue(b, b.value.slice(0, b.cursor) + clean + b.value.slice(b.cursor), b.cursor + clean.length));
      }
    },
    { isActive: active },
  );

  const { value, cursor } = get();
  const tagsWidth = tags.length ? tags.join('] [').length + 4 : 0;
  const avail = width ? width - 4 - 2 - tagsWidth - 1 : Infinity;
  const shown = windowText(value.replace(/\n/g, '↵'), cursor, avail);
  const { before, at, after } = shown;
  return (
    <Box borderStyle="round" borderColor={active ? ACCENT : 'gray'} paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={ACCENT} bold>{'> '}</Text>
        {busyText ? (
          <Text dimColor>{busyText}</Text>
        ) : value.length === 0 && placeholder ? (
          <Text>{active ? <Text inverse>{' '}</Text> : null}<Text dimColor>{placeholder}</Text></Text>
        ) : (
          <Text>{before}{active ? <Text inverse>{at}</Text> : at === ' ' ? '' : at}{after}</Text>
        )}
      </Box>
      {tags.length > 0 ? <Text color="yellow">{tags.map((t) => `[${t}]`).join(' ')}</Text> : null}
    </Box>
  );
}
