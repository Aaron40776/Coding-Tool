import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
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

/** Claude-Code-style rounded input with a block cursor, history, and basic line editing. */
export function InputBox({ onSubmit, active, tags = [], placeholder, busyText }: InputBoxProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const set = (v: string, c = v.length) => {
    setValue(v);
    setCursor(c);
  };

  useInput(
    (input, key) => {
      if (key.return) {
        const text = value.trim();
        if (!text) return;
        setHistory((h) => [...h, text]);
        setHistIdx(null);
        set('');
        onSubmit(text);
      } else if (key.upArrow) {
        if (history.length === 0) return;
        const i = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(i);
        set(history[i] ?? '');
      } else if (key.downArrow) {
        if (histIdx === null) return;
        const i = histIdx + 1;
        if (i >= history.length) {
          setHistIdx(null);
          set('');
        } else {
          setHistIdx(i);
          set(history[i] ?? '');
        }
      } else if (key.leftArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.rightArrow) setCursor((c) => Math.min(value.length, c + 1));
      else if (key.home || (key.ctrl && input === 'a')) setCursor(0);
      else if (key.end || (key.ctrl && input === 'e')) setCursor(value.length);
      else if (key.ctrl && input === 'u') set(value.slice(cursor), 0);
      else if (key.ctrl && input === 'w') {
        const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
        set(before + value.slice(cursor), before.length);
      } else if (key.backspace || key.delete) {
        if (cursor > 0) set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      } else if (input && !key.ctrl && !key.meta && !key.tab && !key.escape && !key.pageUp && !key.pageDown) {
        const clean = input.replace(/[\r\n]+/g, ' '); // pasted newlines become spaces
        set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
      }
    },
    { isActive: active },
  );

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
