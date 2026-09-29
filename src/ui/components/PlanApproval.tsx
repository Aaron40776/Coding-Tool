import { Box, Text, useInput } from 'ink';
import type { ModelTier, Plan, RouteDecision } from '../../core/types.js';
import { ACCENT } from '../theme.js';
import { useLive } from '../useLive.js';
import { StepBadge } from './StepBadge.js';

const CYCLE: (ModelTier | undefined)[] = [undefined, 'haiku', 'sonnet', 'opus'];

type Edit = { field: 'title' | 'instructions'; buffer: string } | null;

export interface PlanApprovalProps {
  plan: Plan;
  routes: Record<string, RouteDecision>;
  onApprove: (plan: Plan) => void;
  onCancel: () => void;
  height?: number;
}

/** Review screen: skip steps, override a step's model, edit its title/instructions, then approve. */
export function PlanApproval({ plan, routes, onApprove, onCancel, height }: PlanApprovalProps) {
  const [get, set] = useLive<{ steps: Plan['steps']; cursor: number; edit: Edit; warning: string }>({ steps: plan.steps, cursor: 0, edit: null, warning: '' });

  const patch = (i: number, p: Partial<Plan['steps'][number]>) =>
    set((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...p } : st)) }));

  useInput((input, key) => {
    const { steps, cursor, edit } = get();
    if (edit) {
      if (key.return) {
        const text = edit.buffer.trim();
        if (text) patch(cursor, { [edit.field]: text });
        set((s) => ({ ...s, edit: null }));
      } else if (key.escape) set((s) => ({ ...s, edit: null }));
      else if (key.backspace || key.delete) set((s) => ({ ...s, edit: { ...edit, buffer: edit.buffer.slice(0, -1) } }));
      else if (input && !key.ctrl && !key.meta) set((s) => ({ ...s, edit: { ...edit, buffer: edit.buffer + input.replace(/[\r\n]+/g, ' ') } }));
      return;
    }
    const step = steps[cursor];
    if (key.upArrow) set((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
    else if (key.downArrow) set((s) => ({ ...s, cursor: Math.min(s.steps.length - 1, s.cursor + 1) }));
    else if (input === ' ' && step) {
      patch(cursor, { skipped: !step.skipped });
      set((s) => ({ ...s, warning: '' }));
    } else if (input === 'm' && step) {
      patch(cursor, { tier: CYCLE[(CYCLE.indexOf(step.tier) + 1) % CYCLE.length] });
    } else if (input === 'e' && step) set((s) => ({ ...s, edit: { field: 'title', buffer: step.title } }));
    else if (input === 'i' && step) set((s) => ({ ...s, edit: { field: 'instructions', buffer: step.instructions } }));
    else if (key.return) {
      if (steps.every((s) => s.skipped)) set((s) => ({ ...s, warning: 'Every step is skipped. Un-skip one with Space, or press Esc to cancel.' }));
      else onApprove({ ...plan, steps });
    } else if (key.escape) onCancel();
  });

  const { steps, cursor, edit, warning } = get();
  const sel = steps[cursor];
  const selRoute = sel ? routes[sel.id] : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} flexGrow={1} height={height} overflow="hidden">
      <Text bold color={ACCENT}>Review plan</Text>
      <Text dimColor wrap="truncate-end">{plan.summary}</Text>
      <Box flexDirection="column" marginTop={1}>
        {steps.map((s, i) => {
          const route = routes[s.id];
          const tier = s.tier ?? route?.tier;
          const isSel = i === cursor;
          return (
            <Box key={s.id}>
              <Text color={ACCENT}>{isSel ? '▸ ' : '  '}</Text>
              <Text dimColor={Boolean(s.skipped)}>{s.skipped ? '[ ] ' : '[x] '}</Text>
              <Text bold={isSel} dimColor={Boolean(s.skipped)} strikethrough={Boolean(s.skipped)} wrap="truncate-end">{`${i + 1}. ${s.title} `}</Text>
              {tier && !s.skipped ? <StepBadge tier={tier} /> : null}
              {s.tier && !s.skipped ? <Text dimColor> (your choice)</Text> : null}
            </Box>
          );
        })}
      </Box>
      {sel ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {edit ? (
            <Text>
              <Text color="yellow">{`Editing ${edit.field}: `}</Text>
              {edit.buffer}
              <Text inverse> </Text>
            </Text>
          ) : (
            <>
              <Text wrap="truncate-end">{sel.instructions}</Text>
              {selRoute && !sel.tier ? <Text dimColor>{`Model: ${selRoute.reason}`}</Text> : null}
              {sel.files.length ? <Text dimColor wrap="truncate-end">{`Files: ${sel.files.join(', ')}`}</Text> : null}
              {sel.acceptance.map((a, i) => <Text key={i} dimColor wrap="truncate-end">{`✓ ${a}`}</Text>)}
            </>
          )}
        </Box>
      ) : null}
      {warning ? <Text color="yellow">{warning}</Text> : null}
      <Text dimColor>{edit ? 'Enter save · Esc discard' : '↑↓ select · Space skip · m model · e/i edit · Enter run · Esc cancel'}</Text>
    </Box>
  );
}
