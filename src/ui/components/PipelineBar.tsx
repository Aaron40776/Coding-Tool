import { Box, Text } from 'ink';
import type { Stage, StageStatus } from '../../core/events.js';
import { ACCENT } from '../theme.js';
import { Spinner } from './Spinner.js';

const SHOWN: { stage: Stage; label: string }[] = [
  { stage: 'classify', label: 'classify' },
  { stage: 'plan', label: 'plan' },
  { stage: 'execute', label: 'execute' },
  { stage: 'verify', label: 'verify' },
];

function Icon({ status, still }: { status: StageStatus; still?: boolean }) {
  switch (status) {
    case 'active':
      return <Spinner color={ACCENT} still={still} />;
    case 'done':
      return <Text color="green">✓</Text>;
    case 'failed':
      return <Text color="red">✗</Text>;
    case 'skipped':
      return <Text dimColor>–</Text>;
    default:
      return <Text dimColor>○</Text>;
  }
}

/** classify → plan → execute → verify. Approval is shown as part of the plan stage. */
export function PipelineBar({ stages, compact }: { stages: Record<Stage, StageStatus>; compact?: boolean }) {
  const status = (s: Stage): StageStatus => (s === 'plan' && stages.approve === 'active' ? 'active' : stages[s]);
  return (
    <Box>
      {SHOWN.map(({ stage, label }, i) => {
        const st = status(stage);
        return (
          <Box key={stage} flexShrink={0}>
            {i > 0 ? <Box flexShrink={0}><Text dimColor>{compact ? '→' : ' → '}</Text></Box> : null}
            <Icon status={st} still={stage === 'plan' && stages.approve === 'active'} />
            <Text bold={st === 'active'} dimColor={st === 'pending' || st === 'skipped'}>{` ${label}`}</Text>
            {stage === 'plan' && stages.approve === 'active' && !compact ? <Text color="yellow"> (review)</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
