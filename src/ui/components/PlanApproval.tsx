import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { ModelTier, Plan, RouteDecision } from '../../core/types.js';
import { ACCENT } from '../theme.js';
import { useLive } from '../useLive.js';
import { wrapText } from './OutputLog.js';
import { StepBadge } from './StepBadge.js';

const CYCLE: (ModelTier | undefined)[] = [undefined, 'haiku', 'sonnet', 'opus'];

type Edit = { field: 'title' | 'instructions'; buffer: string; /** A step just added with `a`: Esc removes it again. */ fresh?: boolean } | null;

export interface PlanApprovalProps {
  plan: Plan;
  routes: Record<string, RouteDecision>;
  onApprove: (plan: Plan) => void;
  onCancel: () => void;
  /** Total height and width available; every line is pre-wrapped so nothing overflows the terminal. */
  height?: number;
  width?: number;
}

/** Below this many inner rows the screen drops its summary, spacers and detail border so the essentials still fit. */
export const COMPACT_BELOW = 14;

const HINTS: [number, string][] = [
  [98, '↑↓ · Space skip · a add · d del · J/K move · m model · e/i edit · PgUp/Dn · Enter run · Esc cancel'],
  [71, '↑↓ Space a add d del J/K move m model e/i edit · Enter run · Esc cancel'],
  [51, '↑↓ · Space · a d J/K · m · e/i · Enter · Esc cancel'],
  [0, '↑↓ Space a d J/K m e/i · Enter · Esc cancel'],
];
const hint = (w: number): string => HINTS.find(([min]) => w >= min)![1];

/** Splits the available rows between the step list and the detail box. Exported for tests. */
export function budget(inner: number, summaryLines: number, steps: number, hasWarning: boolean): { list: number; detail: number } {
  if (inner < COMPACT_BELOW) {
    // title + list + detail + hint (+ warning): nothing else
    const room = Math.max(2, inner - 2 - (hasWarning ? 1 : 0));
    const list = Math.max(1, Math.min(steps, Math.floor(room / 2)));
    return { list, detail: Math.max(1, room - list) };
  }
  // title + summary + blank + blank + detail borders(2) + hint (+ warning)
  const fixed = 1 + summaryLines + 1 + 1 + 2 + 1 + (hasWarning ? 1 : 0);
  const room = Math.max(2, inner - fixed);
  const list = Math.min(steps, Math.max(3, room - 6));
  const listClamped = Math.max(1, Math.min(list, room - 1));
  return { list: listClamped, detail: Math.max(1, room - listClamped) };
}

/** Review screen: skip, add, delete and reorder steps, override a step's model, edit title/instructions, then approve. */
export function PlanApproval({ plan, routes, onApprove, onCancel, height = 24, width = 100 }: PlanApprovalProps) {
  const [get, set] = useLive<{ steps: Plan['steps']; cursor: number; edit: Edit; warning: string; dscroll: number }>({
    steps: plan.steps, cursor: 0, edit: null, warning: '', dscroll: 0,
  });

  const patch = (i: number, p: Partial<Plan['steps'][number]>) =>
    set((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...p } : st)) }));
  const move = (cursor: number) => set((s) => ({ ...s, cursor, dscroll: 0 }));
  const uid = useRef(0);
  const maxScroll = useRef(0);
  const swap = (i: number, j: number) =>
    set((s) => {
      if (j < 0 || j >= s.steps.length) return s;
      const steps = [...s.steps];
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...s, steps, cursor: j, dscroll: 0 };
    });

  useInput((input, key) => {
    const { steps, cursor, edit } = get();
    if (edit) {
      const multiline = edit.field === 'instructions';
      if (key.return && multiline && (key.meta || edit.buffer.endsWith('\\'))) {
        // Alt+Enter, or a trailing backslash then Enter, adds a line break.
        const buffer = key.meta ? `${edit.buffer}\n` : `${edit.buffer.slice(0, -1)}\n`;
        set((s) => ({ ...s, edit: { ...edit, buffer } }));
      } else if (key.return) {
        const text = edit.buffer.trim();
        if (edit.fresh && edit.field === 'title' && !text) {
          // A new step needs a name: an empty one cancels it, like Esc.
          set((s) => ({ ...s, steps: s.steps.filter((_, j) => j !== cursor), cursor: Math.max(0, cursor - 1), edit: null }));
          return;
        }
        // A step added with `a` must not end up without instructions: fall back to its title.
        if (text) patch(cursor, { [edit.field]: text });
        else if (edit.fresh && edit.field === 'instructions') patch(cursor, { instructions: get().steps[cursor]?.title ?? '' });
        set((s) => ({ ...s, edit: null }));
        // A freshly added step needs instructions: continue straight to them.
        if (edit.fresh && edit.field === 'title') set((s) => ({ ...s, edit: { field: 'instructions', buffer: '', fresh: true } }));
      } else if (key.escape) {
        if (edit.fresh && edit.field === 'instructions') {
          patch(cursor, { instructions: get().steps[cursor]?.title ?? '' });
          set((s) => ({ ...s, edit: null }));
        } else if (edit.fresh) {
          // Cancelling the creation of a step removes the empty placeholder again.
          set((s) => ({ ...s, steps: s.steps.filter((_, j) => j !== cursor), cursor: Math.max(0, cursor - 1), edit: null }));
        } else set((s) => ({ ...s, edit: null }));
      } else if (key.backspace || key.delete) set((s) => ({ ...s, edit: { ...edit, buffer: edit.buffer.slice(0, -1) } }));
      else if (input && !key.ctrl && !key.meta) {
        // Pasted text keeps its line breaks in instructions; a title stays on one line.
        const text = multiline ? input.replace(/\r\n?/g, '\n') : input.replace(/[\r\n]+/g, ' ');
        set((s) => ({ ...s, edit: { ...edit, buffer: edit.buffer + text } }));
      }
      return;
    }
    const step = steps[cursor];
    if (key.upArrow) move(Math.max(0, cursor - 1));
    else if (key.downArrow) move(Math.min(steps.length - 1, cursor + 1));
    else if (key.pageDown) set((s) => ({ ...s, dscroll: Math.min(maxScroll.current, s.dscroll + 4) }));
    else if (key.pageUp) set((s) => ({ ...s, dscroll: Math.max(0, s.dscroll - 4) }));
    else if (input === ' ' && step) {
      patch(cursor, { skipped: !step.skipped });
      set((s) => ({ ...s, warning: '' }));
    } else if (input === 'm' && step) {
      patch(cursor, { tier: CYCLE[(CYCLE.indexOf(step.tier) + 1) % CYCLE.length] });
    } else if (input === 'a') {
      uid.current += 1;
      const fresh = { id: `u${uid.current}${Date.now().toString(36)}`, title: '', instructions: '', files: [], acceptance: [] };
      set((s) => {
        const steps = [...s.steps];
        steps.splice(s.cursor + 1, 0, fresh);
        return { ...s, steps, cursor: s.cursor + 1, dscroll: 0, warning: '', edit: { field: 'title', buffer: '', fresh: true } };
      });
    } else if (input === 'd' && step) {
      if (steps.length === 1) set((s) => ({ ...s, warning: 'A plan needs at least one step. Press Esc to cancel it instead.' }));
      else set((s) => ({ ...s, steps: s.steps.filter((_, j) => j !== cursor), cursor: Math.min(cursor, s.steps.length - 2), dscroll: 0, warning: '' }));
    } else if (input === 'K' && step) swap(cursor, cursor - 1);
    else if (input === 'J' && step) swap(cursor, cursor + 1);
    else if (input === 'e' && step) set((s) => ({ ...s, edit: { field: 'title', buffer: step.title } }));
    else if (input === 'i' && step) set((s) => ({ ...s, edit: { field: 'instructions', buffer: step.instructions } }));
    else if (key.return) {
      if (steps.every((s) => s.skipped)) set((s) => ({ ...s, warning: 'Every step is skipped. Un-skip one with Space, or press Esc to cancel.' }));
      else onApprove({ ...plan, steps });
    } else if (key.escape) onCancel();
  });

  const { steps, cursor, edit, warning, dscroll } = get();
  const W = Math.max(20, width - 4); // inside the outer border + padding
  const DW = Math.max(16, W - (height - 2 < COMPACT_BELOW ? 0 : 4)); // inside the detail box border + padding (none when compact)
  const summary = wrapText(plan.summary, W);
  const compact = height - 2 < COMPACT_BELOW;
  const summaryLines = compact ? [] : summary.slice(0, 2);
  if (!compact && summary.length > 2) summaryLines[1] = `${summaryLines[1]!.slice(0, Math.max(0, W - 1))}…`;
  const { list, detail } = budget(height - 2, summaryLines.length, steps.length, Boolean(warning));

  const sel = steps[cursor];
  const selRoute = sel ? routes[sel.id] : undefined;

  // Full, wrapped detail text for the selected step (or the edit buffer), then a window over it.
  let content: { text: string; style?: 'title' | 'dim' | 'edit' }[] = [];
  if (sel) {
    if (edit) {
      content = `Editing ${edit.field}${edit.field === 'instructions' ? ' (Alt+Enter or \\ then Enter = new line)' : ''}: ${edit.buffer}▏`
        .split('\n')
        .flatMap((line) => wrapText(line, DW))
        .map((text) => ({ text, style: 'edit' as const }));
    } else {
      content = [
        ...wrapText(sel.title, DW).map((text) => ({ text, style: 'title' as const })),
        ...sel.instructions.split('\n').flatMap((line) => wrapText(line, DW)).map((text) => ({ text })),
        ...(selRoute && !sel.tier ? wrapText(`Model: ${selRoute.reason}`, DW).map((text) => ({ text, style: 'dim' as const })) : []),
        ...(sel.files.length ? wrapText(`Files: ${sel.files.join(', ')}`, DW).map((text) => ({ text, style: 'dim' as const })) : []),
        ...sel.acceptance.flatMap((a) => wrapText(`✓ ${a}`, DW).map((text) => ({ text, style: 'dim' as const }))),
      ];
    }
  }
  const editing = Boolean(edit);
  // While editing show the END of the buffer (where the cursor is); otherwise the scrolled window.
  maxScroll.current = Math.max(0, content.length - detail); // PgDn stops here, so PgUp always responds at once
  const start = editing ? Math.max(0, content.length - detail) : Math.min(dscroll, maxScroll.current);
  let shown = content.slice(start, start + detail);
  const hiddenBelow = content.length - (start + shown.length);
  if (hiddenBelow > 0 && shown.length > 0) shown = [...shown.slice(0, -1), { text: `… ${hiddenBelow + 1} more lines (PgDn)`, style: 'dim' as const }];

  const winStart = Math.max(0, Math.min(cursor - Math.floor(list / 2), steps.length - list));
  const visible = steps.slice(winStart, winStart + list);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={width} height={height} overflow="hidden">
      <Text wrap="truncate-end">
        <Text bold color={ACCENT}>Review plan</Text>
        <Text dimColor>{`  step ${cursor + 1} of ${steps.length}${steps.some((s) => s.skipped) ? ` · ${steps.filter((s) => s.skipped).length} skipped` : ''}`}</Text>
      </Text>
      {summaryLines.map((l, i) => <Text key={i} dimColor wrap="truncate-end">{l}</Text>)}
      {compact ? null : <Text> </Text>}
      <Box flexDirection="column" height={list} flexShrink={0}>
        {visible.map((s, k) => {
          const i = winStart + k;
          const route = routes[s.id];
          const tier = s.tier ?? route?.tier;
          const isSel = i === cursor;
          return (
            <Box key={s.id}>
              <Box flexShrink={0}>
                <Text color={ACCENT}>{isSel ? '▸ ' : '  '}</Text>
                <Text dimColor={Boolean(s.skipped)}>{s.skipped ? '[ ] ' : '[x] '}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text bold={isSel} dimColor={Boolean(s.skipped)} strikethrough={Boolean(s.skipped)} wrap="truncate-end">{`${i + 1}. ${s.title}`}</Text>
              </Box>
              {tier && !s.skipped ? (
                <Box flexShrink={0} marginLeft={1}>
                  <StepBadge tier={tier} />
                  {s.tier ? <Text dimColor> (yours)</Text> : null}
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {compact ? null : <Text> </Text>}
      <Box flexDirection="column" borderStyle={compact ? undefined : 'single'} borderColor={editing ? 'yellow' : 'gray'} paddingX={compact ? 0 : 1} height={compact ? detail : detail + 2} flexShrink={0}>
        {shown.map((c, i) => (
          <Text key={i} wrap="truncate-end" bold={c.style === 'title'} dimColor={c.style === 'dim'} color={c.style === 'edit' ? 'yellow' : undefined}>{c.text}</Text>
        ))}
      </Box>
      {warning ? <Text color="yellow" wrap="truncate-end">{warning}</Text> : null}
      <Text dimColor wrap="truncate-end">
        {editing ? 'Enter save · Esc discard' : hint(W)}
      </Text>
    </Box>
  );
}
