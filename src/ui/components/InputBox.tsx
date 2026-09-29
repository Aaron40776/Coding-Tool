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
}

interface Buf {
  value: string;
  cursor: number;
  history: string[];
  histIdx: number | null;
}

const withValue = (b: Buf, value: string, cursor = value.length): Buf => ({ ...b, value, cursor });

/** Claude-Code-style rounded input with a block cursor, history, and basic line editing. */
export function InputBox({ onSubmit, active, tags = [], placeholder, busyText }: InputBoxProps) {
  const [get, set] = useLive<Buf>({ value: '', cursor: 0, history: [], histIdx: null });

  useInput(
    (input, key) => {
      const b = get();
      if (key.return) {
        const text = b.value.trim();
        if (!text) return;
        set({ value: '', cursor: 0, history: [...b.history, text], histIdx: null });
        onSubmit(text);
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
      } else if (input && !key.ctrl && !key.meta && !key.tab && !key.escape && !key.pageUp && !key.pageDown) {
        const clean = input.replace(/[\r\n]+/g, ' '); // pasted newlines become spaces, never a submit
        set(withValue(b, b.value.slice(0, b.cursor) + clean + b.value.slice(b.cursor), b.cursor + clean.length));
      }
    },
    { isActive: active },
  );

  const { value, cursor } = get();
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);
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
