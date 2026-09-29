import { Box, Text } from 'ink';
import type { ModelTier, Plan, RouteDecision } from '../../core/types.js';
import type { StepStatus } from '../state.js';
import { fmtDuration } from '../format.js';
import { ACCENT } from '../theme.js';
import { Spinner } from './Spinner.js';
import { StepBadge } from './StepBadge.js';

function Mark({ status }: { status: StepStatus }) {
  switch (status) {
    case 'done':
      return <Text color="green">✓</Text>;
    case 'active':
    case 'verifying':
      return <Spinner color={ACCENT} />;
    case 'failed':
      return <Text color="red">✗</Text>;
    case 'cancelled':
      return <Text color="yellow">■</Text>;
    case 'skipped':
      return <Text dimColor>–</Text>;
    default:
      return <Text dimColor>○</Text>;
  }
}

export interface PlanChecklistProps {
  plan?: Plan;
  routes: Record<string, RouteDecision>;
  stepStatus: Record<string, StepStatus>;
  escalatedTo: Record<string, ModelTier>;
  durations?: Record<string, number>;
  selected?: number;
  focused?: boolean;
  height?: number;
}

/** The plan as a live checklist: status mark, title, model badge, and the routing reason underneath. */
export function PlanChecklist({ plan, routes, stepStatus, escalatedTo, durations, selected, focused, height }: PlanChecklistProps) {
  // Long plans are windowed around the step in focus (the selected one, else the one running) so the current step never scrolls out of sight.
  const steps = plan?.steps ?? [];
  const rowsPer = 2;
  const room = height === undefined ? steps.length : Math.max(1, Math.floor((height - 3) / rowsPer));
  const windowed = steps.length > room;
  const size = windowed ? Math.max(1, room - 1) : steps.length; // one row is kept for the "more" note
  const focus = focused && selected !== undefined ? selected : Math.max(0, steps.findIndex((s) => { const st = stepStatus[s.id]; return st === 'active' || st === 'verifying'; }));
  const first = windowed ? Math.max(0, Math.min(focus - Math.floor(size / 2), steps.length - size)) : 0;
  const shown = steps.slice(first, first + size);
  const before = first;
  const after = steps.length - first - shown.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? ACCENT : 'gray'} paddingX={1} overflow="hidden" height={height}>
      <Text bold>Plan</Text>
      {!plan ? (
        <Text dimColor>No plan yet.</Text>
      ) : (
        shown.map((step, k) => {
          const i = first + k;
          const status = step.skipped ? 'skipped' : (stepStatus[step.id] ?? 'pending');
          const route = routes[step.id];
          const tier = escalatedTo[step.id] ?? route?.tier;
          const isSel = focused && selected === i;
          return (
            <Box key={step.id} flexDirection="column">
              <Box>
                <Box flexShrink={0}>
                  <Mark status={status} />
                </Box>
                <Box flexShrink={1}>
                  <Text bold={isSel} inverse={isSel} dimColor={status === 'skipped'} wrap="truncate-end">{` ${i + 1}. ${step.title}`}</Text>
                </Box>
                {tier ? (
                  <Box flexShrink={0} marginLeft={1}>
                    <StepBadge tier={tier} escalated={Boolean(escalatedTo[step.id])} />
                    {durations?.[step.id] !== undefined ? <Text dimColor>{` ${fmtDuration(durations[step.id]!)}`}</Text> : null}
                  </Box>
                ) : null}
              </Box>
              {route ? (
                <Text dimColor wrap="truncate-end">{`   ${escalatedTo[step.id] ? `escalated from ${route.tier}` : route.reason}`}</Text>
              ) : null}
            </Box>
          );
        })
      )}
      {windowed ? <Text dimColor wrap="truncate-end">{`${before > 0 ? `↑ ${before} earlier` : ''}${before > 0 && after > 0 ? ' · ' : ''}${after > 0 ? `↓ ${after} more` : ''}`}</Text> : null}
    </Box>
  );
}
