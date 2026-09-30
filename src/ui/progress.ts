import type { UiState } from './state.js';

/**
 * Progress on the terminal tab and the Windows taskbar button (Windows Terminal and ConEmu understand `OSC 9;4`; other
 * terminals ignore it). You see a long task move, wait for your approval or fail while working in another window.
 *   0 clear · 1 percent · 2 error · 3 busy (no percent) · 4 paused (waiting for you)
 */
export interface TermProgress {
  state: 0 | 1 | 2 | 3 | 4;
  percent: number;
}

export function progressFor(s: Pick<UiState, 'phase' | 'ok' | 'plan' | 'stepStatus'>): TermProgress {
  if (s.phase === 'approval') return { state: 4, percent: 100 };
  if (s.phase === 'finished') return s.ok === false ? { state: 2, percent: 100 } : { state: 0, percent: 0 };
  if (s.phase !== 'running') return { state: 0, percent: 0 };
  const steps = s.plan?.steps.filter((st) => !st.skipped) ?? [];
  // One step, or still classifying and planning: no meaningful percentage.
  if (steps.length < 2) return { state: 3, percent: 0 };
  const done = steps.filter((st) => s.stepStatus[st.id] === 'done').length;
  // A sliver while the first step runs, so the bar is visibly there.
  return { state: 1, percent: Math.max(3, Math.round((done / steps.length) * 100)) };
}

export const progressSequence = (p: TermProgress): string => `\x1b]9;4;${p.state};${p.percent}\x07`;
export const CLEAR_PROGRESS = progressSequence({ state: 0, percent: 0 });
