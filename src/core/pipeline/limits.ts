import type { SmartConfig } from '../config.js';
import type { SmartError } from '../errors.js';
import type { EventBus } from '../events.js';
import type { LimitsStore } from '../store/limits.js';
import type { Limits } from '../types.js';
import { fmtReset, pct, tightest, windowLabel } from '../usage.js';

/**
 * Your Claude account's usage windows (5-hour, 7-day) as the calls report them: kept for routing (limit pressure) and the
 * header, saved between runs, and warned about once per window and level.
 */
export class AccountLimits {
  current: Limits | null;
  private warned = new Set<string>();

  constructor(
    private readonly config: SmartConfig,
    private readonly bus: EventBus,
    private readonly now: () => number,
    initial: Limits | null,
    private readonly store?: LimitsStore,
  ) {
    this.current = initial;
  }

  observe(windows: Limits['windows'], status?: string): void {
    this.current = { windows, status, at: this.now() };
    this.store?.save(this.current);
    this.bus.emit({ type: 'limits', limits: this.current });
    const warnAt = this.config.usage.warnAt;
    if (!warnAt) return;
    for (const [name, w] of Object.entries(windows)) {
      const level = w.utilization >= 0.95 ? 'critical' : w.utilization >= warnAt ? 'warn' : null;
      if (!level) continue;
      const key = `${name}:${w.resetsAt ?? ''}:${level}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      const reset = fmtReset(w.resetsAt, this.now());
      const hint = this.config.usage.downshiftAt && w.utilization >= this.config.usage.downshiftAt ? ' Automatic routing is avoiding Opus until it resets.' : '';
      this.bus.emit({ type: 'notice', level: 'warn', message: `Your ${windowLabel(name)} usage limit is ${pct(w.utilization)} used${reset ? ` (resets in ${reset})` : ''}.${hint}` });
    }
  }

  /** "Your Claude usage limit is reached: … (resets in 2h 14m)" using the reset time Claude gave, or the last one it reported. */
  message(err: SmartError): string {
    const resetsAt = err.resetsAt ?? tightest(this.current, this.now())?.window.resetsAt;
    const reset = fmtReset(resetsAt, this.now());
    return reset && !/resets/i.test(err.message) ? `${err.message} (resets in ${reset})` : err.message;
  }
}
