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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? ACCENT : 'gray'} paddingX={1} overflow="hidden" height={height}>
      <Text bold>Plan</Text>
      {!plan ? (
        <Text dimColor>No plan yet.</Text>
      ) : (
        plan.steps.map((step, i) => {
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
    </Box>
  );
}
