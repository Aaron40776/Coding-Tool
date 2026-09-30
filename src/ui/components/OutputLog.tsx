import { Box, Text } from 'ink';
import { useEffect, useMemo } from 'react';
import type { OutputLine } from '../state.js';
import { ACCENT } from '../theme.js';

const MAX_LINES_PER_ENTRY = 8;
/** Only long tool/command output is shortened. Replies, help, diffs and stats are shown in full (they scroll). */
const CAPPED = new Set<OutputLine['kind']>(['verify-ok', 'verify-fail', 'error']);

export interface Segment {
  text: string;
  style: 'plain' | 'bold' | 'code';
}

/** Tiny inline-markdown pass for assistant text: **bold**, `code`, "## heading" and "- bullet" lines. */
export function inlineSegments(line: string): Segment[] {
  const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
  if (heading) return [{ text: heading[1] ?? '', style: 'bold' }];
  const text = line.replace(/^(\s*)[-*]\s+/, '$1• ');
  const out: Segment[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push({ text: part.slice(2, -2), style: 'bold' });
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push({ text: part.slice(1, -1), style: 'code' });
    else out.push({ text: part, style: 'plain' });
  }
  return out;
}

interface Row {
  key: string;
  kind: OutputLine['kind'];
  text: string;
  first: boolean;
}

/** Word-wraps to `width` columns, hard-splitting words longer than a line. */
export function wrapText(text: string, width: number): string[] {
  if (width < 10 || text.length <= width) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let w = word;
    while (w.length > width) {
      if (line) {
        out.push(line);
        line = '';
      }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

export function toRows(lines: OutputLine[], width = 0): Row[] {
  return lines.flatMap((l) => {
    // Tool lines stay on one row (paths); everything else is wrapped so reasons and errors stay readable.
    const wrapped = l.kind === 'tool' || l.kind.startsWith('diff') || width === 0 ? l.text.split('\n') : l.text.split('\n').flatMap((p) => wrapText(p, width));
    const parts = wrapped;
    const shown = CAPPED.has(l.kind) && parts.length > MAX_LINES_PER_ENTRY ? [...parts.slice(0, MAX_LINES_PER_ENTRY), `… ${parts.length - MAX_LINES_PER_ENTRY} more lines`] : parts;
    return shown.map((text, i) => ({ key: `${l.id}:${i}`, kind: l.kind, text, first: i === 0 }));
  });
}

function RowView({ row }: { row: Row }) {
  const t = row.text;
  switch (row.kind) {
    case 'user':
      return <Text bold>{row.first ? `> ${t}` : `  ${t}`}</Text>;
    case 'tool':
      return <Text wrap="truncate-end"><Text color={ACCENT}>⏺ </Text><Text dimColor>{t}</Text></Text>;
    case 'text':
      return (
        <Text wrap="truncate-end">
          {'  '}
          {inlineSegments(t).map((seg, i) => (
            <Text key={i} bold={seg.style === 'bold'} color={seg.style === 'code' ? 'cyan' : undefined}>{seg.text}</Text>
          ))}
        </Text>
      );
    case 'warn':
      return <Text color="yellow" wrap="truncate-end">{row.first ? `! ${t}` : `  ${t}`}</Text>;
    case 'error':
      return <Text color="red" wrap="truncate-end">{row.first ? `✗ ${t}` : `  ${t}`}</Text>;
    case 'verify-ok':
      return <Text color="green" wrap="truncate-end">{`  ${t}`}</Text>;
    case 'verify-fail':
      return <Text color="red" wrap="truncate-end">{`  ${t}`}</Text>;
    case 'diff-add':
      return <Text color="green" wrap="truncate-end">{`  ${t}`}</Text>;
    case 'diff-del':
      return <Text color="red" wrap="truncate-end">{`  ${t}`}</Text>;
    case 'diff-ctx':
      return <Text dimColor wrap="truncate-end">{`  ${t}`}</Text>;
    case 'diff-meta':
      return <Text color="cyan" dimColor wrap="truncate-end">{`  ${t}`}</Text>;
    default:
      return <Text dimColor wrap="truncate-end">{row.first ? `· ${t}` : `  ${t}`}</Text>;
  }
}

export interface OutputLogProps {
  lines: OutputLine[];
  height: number;
  /** Rows scrolled up from the bottom (0 = follow the newest output). */
  scroll: number;
  /** Inner width of the panel, used to wrap long lines. */
  width?: number;
  focused?: boolean;
  welcome?: string[];
  /** Reports how far up the log can be scrolled, so key handlers can stop there. */
  onMaxScroll?: (max: number) => void;
}

export function OutputLog({ lines, height, scroll: wanted, width, focused, welcome, onMaxScroll }: OutputLogProps) {
  // Wrapping every line is the costliest part of a frame; token updates re-render often without changing the log.
  const wrapAt = width ? width - 4 : 0; // minus the 2-col row prefix and a margin
  const rows = useMemo(() => toRows(lines, wrapAt), [lines, wrapAt]);
  const visible = Math.max(1, height - 3); // borders + title
  const max = Math.max(0, rows.length - visible);
  const scroll = Math.min(wanted, max); // never scroll past the first row
  useEffect(() => onMaxScroll?.(max), [max, onMaxScroll]);
  const end = Math.max(0, rows.length - scroll);
  const slice = rows.slice(Math.max(0, end - visible), end);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focused ? ACCENT : 'gray'} paddingX={1} overflow="hidden" height={height}>
      <Text bold>
        Output{scroll > 0 ? <Text dimColor>{`  (scrolled ${scroll} up, ↓ to follow)`}</Text> : null}
      </Text>
      {rows.length === 0 && welcome ? welcome.map((w, i) => <Text key={i} dimColor>{w}</Text>) : null}
      {slice.map((r) => <RowView key={r.key} row={r} />)}
    </Box>
  );
}
