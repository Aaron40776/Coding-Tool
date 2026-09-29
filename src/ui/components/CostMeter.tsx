import { Text } from 'ink';
import type { Usage } from '../../core/types.js';
import { billableTokens, fmtCost, fmtTokens } from '../format.js';

export function CostMeter({ task, session, showTask, compact }: { task: Usage; session: Usage; showTask: boolean; compact?: boolean }) {
  if (compact) {
    return (
      <Text>
        <Text dimColor>session </Text>
        <Text bold color="yellow">{fmtCost(session.costUsd)}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {showTask ? (
        <>
          <Text dimColor>task </Text>
          <Text bold>{fmtCost(task.costUsd)}</Text>
          <Text dimColor> · {fmtTokens(billableTokens(task))} tok  │  </Text>
        </>
      ) : null}
      <Text dimColor>session </Text>
      <Text bold color="yellow">{fmtCost(session.costUsd)}</Text>
      <Text dimColor>
        {' '}· ↑{fmtTokens(session.inputTokens + session.cacheCreationTokens)} ↓{fmtTokens(session.outputTokens)}
        {session.cacheReadTokens > 0 ? ` · cache ${fmtTokens(session.cacheReadTokens)}` : ''}
      </Text>
    </Text>
  );
}
