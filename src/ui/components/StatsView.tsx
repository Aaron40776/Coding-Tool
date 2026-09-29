import { Box, Text } from 'ink';
import type { Summary } from '../../core/stats.js';
import type { Limits } from '../../core/types.js';
import { bar, fmtReset, pct, pressure, windowLabel } from '../../core/usage.js';
import { fmtCost, fmtTokens } from '../format.js';
import { ACCENT } from '../theme.js';

const money = (n: number): string => fmtCost(Math.abs(n));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface StatsViewProps {
  summary: Summary;
  limits?: Limits | null;
  nowMs?: number;
  path: string;
  height?: number;
  width?: number;
}

/** Usage history: account limits, time windows, per-model spend, escalations, estimated savings, priciest tasks. */
export function StatsView({ summary: s, limits, nowMs = Date.now(), path, height, width }: StatsViewProps) {
  const barW = 12;
  const modelTotal = s.byModel.reduce((n, m) => n + m.cost, 0) + s.overhead;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={width} height={height} overflow="hidden">
      <Text bold color={ACCENT}>Usage history</Text>
      {limits && Object.keys(limits.windows).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Your Claude account</Text>
          {Object.entries(limits.windows).map(([name, w]) => (
            <Text key={name}>
              {`  ${windowLabel(name).padEnd(4)} `}
              <Text color={pressure(w.utilization) === 'high' ? 'red' : pressure(w.utilization) === 'warn' ? 'yellow' : 'green'}>{bar(w.utilization, barW)}</Text>
              {` ${pct(w.utilization).padStart(4)}`}
              <Text dimColor>{w.resetsAt ? `  resets in ${fmtReset(w.resetsAt, nowMs)}` : ''}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {s.all.tasks === 0 ? (
        <Text dimColor>{'\nNo tasks recorded yet.'}</Text>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Spend with smart</Text>
            <Text wrap="truncate-end">{`  Today      ${plural(s.today.tasks, 'task').padEnd(10)} ${money(s.today.cost).padStart(7)}   ${fmtTokens(s.today.tokens)} tok`}</Text>
            <Text wrap="truncate-end">{`  Last 7d    ${plural(s.week.tasks, 'task').padEnd(10)} ${money(s.week.cost).padStart(7)}   ${fmtTokens(s.week.tokens)} tok`}</Text>
            <Text wrap="truncate-end">{`  All time   ${plural(s.all.tasks, 'task').padEnd(10)} ${money(s.all.cost).padStart(7)}   ${fmtTokens(s.all.tokens)} tok · ${s.all.ok} succeeded · avg ${money(s.avgTaskCost)}/task`}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>By model</Text>
            {s.byModel.map((m) => (
              <Text key={m.model} wrap="truncate-end">{`  ${m.model.padEnd(24).slice(0, 24)} ${plural(m.steps, 'step').padEnd(9)} ${money(m.cost).padStart(7)}  ${bar(modelTotal ? m.cost / modelTotal : 0, 8)}`}</Text>
            ))}
            <Text dimColor wrap="truncate-end">{`  classify · plan · review ${money(s.overhead).padStart(24)}  ${bar(modelTotal ? s.overhead / modelTotal : 0, 8)}`}</Text>
            <Text wrap="truncate-end">{`  Escalated ${s.escalatedSteps} of ${plural(s.steps, 'step')} (${s.steps ? Math.round((s.escalatedSteps / s.steps) * 100) : 0}%)`}</Text>
          </Box>
          {s.savings.some((x) => x.baseline > 0) ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Estimated savings <Text dimColor>(list prices in your config; a stronger model might use different tokens)</Text></Text>
              {s.savings.filter((x) => x.baseline > 0).map((x) => (
                <Text key={x.vs} wrap="truncate-end">
                  {`  vs all-${x.vs}`.padEnd(16)}
                  <Text color={x.saved >= 0 ? 'green' : 'red'}>{`${x.saved >= 0 ? '≈ saved' : '≈ extra'} ${money(x.saved)} (${Math.round(Math.abs(x.share) * 100)}%)`}</Text>
                  <Text dimColor>{`   would be ≈ ${money(x.baseline)}`}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
          {s.top.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Most expensive</Text>
              {s.top.map((t, i) => (
                <Text key={i} wrap="truncate-end">
                  <Text color={t.ok ? 'green' : 'red'}>{t.ok ? '  ✓' : '  ✗'}</Text>
                  {` ${money(t.cost).padStart(7)}  ${t.prompt.replace(/\s+/g, ' ')}`}
                </Text>
              ))}
            </Box>
          ) : null}
        </>
      )}
      <Text dimColor wrap="truncate-end">{`${'\n'}${path} · Esc to close`}</Text>
    </Box>
  );
}
