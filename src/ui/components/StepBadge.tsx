import { Text } from 'ink';
import type { ModelTier } from '../../core/types.js';
import { tierLabel } from '../format.js';
import { tierColor } from '../theme.js';

export function StepBadge({ tier, escalated }: { tier: ModelTier | string; escalated?: boolean }) {
  const color = (tierColor as Record<string, string>)[tier] ?? 'gray';
  return (
    <Text>
      <Text backgroundColor={color} color="white" bold>{` ${tierLabel(tier)} `}</Text>
      {escalated ? <Text color="yellow"> ↑</Text> : null}
    </Text>
  );
}
