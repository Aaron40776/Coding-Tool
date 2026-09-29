import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { ModelTier, Plan, RouteDecision } from '../../core/types.js';
import { ACCENT } from '../theme.js';
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
  const [steps, setSteps] = useState(plan.steps);
  const [cursor, setCursor] = useState(0);
  const [edit, setEdit] = useState<Edit>(null);
  const [warning, setWarning] = useState('');

  const patch = (i: number, p: Partial<Plan['steps'][number]>) => setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...p } : st)));

  useInput((input, key) => {
    if (edit) {
      if (key.return) {
        const text = edit.buffer.trim();
        if (text) patch(cursor, { [edit.field]: text });
        setEdit(null);
      } else if (key.escape) setEdit(null);
      else if (key.backspace || key.delete) setEdit({ ...edit, buffer: edit.buffer.slice(0, -1) });
      else if (input && !key.ctrl && !key.meta) setEdit({ ...edit, buffer: edit.buffer + input.replace(/[\r\n]+/g, ' ') });
      return;
    }
    const step = steps[cursor];
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(steps.length - 1, c + 1));
    else if (input === ' ' && step) {
      patch(cursor, { skipped: !step.skipped });
      setWarning('');
    } else if (input === 'm' && step) {
      const next = CYCLE[(CYCLE.indexOf(step.tier) + 1) % CYCLE.length];
      patch(cursor, { tier: next });
    } else if (input === 'e' && step) setEdit({ field: 'title', buffer: step.title });
    else if (input === 'i' && step) setEdit({ field: 'instructions', buffer: step.instructions });
    else if (key.return) {
      if (steps.every((s) => s.skipped)) setWarning('Every step is skipped. Un-skip one with Space, or press Esc to cancel.');
      else onApprove({ ...plan, steps });
    } else if (key.escape) onCancel();
  });

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
