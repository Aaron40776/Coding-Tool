import { Text } from 'ink';
import { pct, pressure, tightest, windowLabel } from '../../core/usage.js';
import type { Limits } from '../../core/types.js';

const COLOR = { ok: 'green', warn: 'yellow', high: 'red' } as const;
const STALE_MS = 30 * 60_000;

/** Account usage in the header: `5h 74% · 7d 18%`, coloured by pressure. Compact mode shows only the tightest window. */
export function LimitsMeter({ limits, nowMs, compact }: { limits: Limits | null; nowMs: number; compact?: boolean }) {
  if (!limits) return null;
  const entries = compact ? (() => { const t = tightest(limits); return t ? [[t.name, t.window] as const] : []; })() : Object.entries(limits.windows);
  if (entries.length === 0) return null;
  const stale = nowMs - limits.at > STALE_MS;
  return (
    <Text>
      {entries.map(([name, w], i) => (
        <Text key={name}>
          {i > 0 ? <Text dimColor> · </Text> : null}
          <Text dimColor>{`${stale ? '~' : ''}${windowLabel(name)} `}</Text>
          <Text color={COLOR[pressure(w.utilization)]} bold={pressure(w.utilization) === 'high'}>{pct(w.utilization)}</Text>
        </Text>
      ))}
    </Text>
  );
}
