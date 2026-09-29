import { Box, Text } from 'ink';
import type { Stats, TaskRecord } from '../../core/tracker.js';
import { billableTokens, fmtCost, fmtTokens } from '../format.js';
import { ACCENT } from '../theme.js';

export function StatsView({ stats, recent, path, height }: { stats: Stats; recent: TaskRecord[]; path: string; height?: number; width?: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} flexGrow={1} height={height} overflow="hidden">
      <Text bold color={ACCENT}>Usage history</Text>
      {stats.tasks === 0 ? (
        <Text dimColor>No tasks recorded yet.</Text>
      ) : (
        <>
          <Text>
            {`${stats.tasks} task${stats.tasks === 1 ? '' : 's'} (${stats.succeeded} succeeded) · `}
            <Text bold color="yellow">{fmtCost(stats.totals.costUsd)}</Text>
            {` · ${fmtTokens(billableTokens(stats.totals))} tokens`}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>By model</Text>
            {stats.byModel.map((m) => (
              <Text key={m.model}>{`  ${m.model.padEnd(28)} ${String(m.steps).padStart(3)} steps  ${fmtCost(m.usage.costUsd).padStart(7)}  ${fmtTokens(billableTokens(m.usage)).padStart(7)} tok`}</Text>
            ))}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Recent</Text>
            {recent.map((t) => (
              <Text key={t.id} wrap="truncate-end">
                <Text color={t.ok ? 'green' : 'red'}>{t.ok ? '✓' : '✗'}</Text>
                {` ${fmtCost(t.totals.costUsd).padStart(7)}  ${t.prompt.replace(/\s+/g, ' ')}`}
              </Text>
            ))}
          </Box>
        </>
      )}
      <Text dimColor>{`${path} · Esc to close`}</Text>
    </Box>
  );
}
