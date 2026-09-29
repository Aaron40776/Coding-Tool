import type { SmartEvent, Stage, StageStatus } from '../core/events.js';
import type { Classification, ModelTier, Plan, RouteDecision, Usage } from '../core/types.js';
import { emptyUsage } from '../core/types.js';
import { fmtCost, fmtDuration } from './format.js';

export type StepStatus = 'pending' | 'active' | 'verifying' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type Phase = 'idle' | 'running' | 'approval' | 'finished';

export interface OutputLine {
  id: number;
  kind: 'text' | 'tool' | 'info' | 'warn' | 'error' | 'verify-ok' | 'verify-fail' | 'user';
  text: string;
  stepId?: string;
}

export interface UiState {
  phase: Phase;
  prompt: string;
  dryRun: boolean;
  stages: Record<Stage, StageStatus>;
  classification?: Classification;
  classifyReason?: string;
  plan?: Plan;
  routes: Record<string, RouteDecision>;
  stepStatus: Record<string, StepStatus>;
  stepAttempt: Record<string, number>;
  /** Tier a step ended up on after escalation. */
  escalatedTo: Record<string, ModelTier>;
  currentStepId?: string;
  output: OutputLine[];
  session: Usage;
  sessionAtTaskStart: Usage;
  ok?: boolean;
  taskStartedAt?: number;
  stepStartedAt: Record<string, number>;
  /** Wall time of finished steps, in ms. */
  stepDuration: Record<string, number>;
  /** Tasks remembered in the current conversation (follow-ups build on them). */
  chatTasks: number;
  nextId: number;
}

const MAX_OUTPUT = 300;

export const initialStages = (): Record<Stage, StageStatus> => ({
  classify: 'pending', plan: 'pending', approve: 'pending', execute: 'pending', verify: 'pending', done: 'pending',
});

export const initialState = (): UiState => ({
  phase: 'idle', prompt: '', dryRun: false, stages: initialStages(), routes: {}, stepStatus: {}, stepAttempt: {},
  escalatedTo: {}, output: [], session: emptyUsage(), sessionAtTaskStart: emptyUsage(), chatTasks: 0, stepStartedAt: {}, stepDuration: {}, nextId: 1,
});

const push = (s: UiState, kind: OutputLine['kind'], text: string, stepId?: string): UiState => ({
  ...s,
  output: [...s.output, { id: s.nextId, kind, text, stepId }].slice(-MAX_OUTPUT),
  nextId: s.nextId + 1,
});

const withDuration = (s: UiState, stepId: string, at?: number): Record<string, number> => {
  const started = s.stepStartedAt[stepId];
  return at !== undefined && started !== undefined ? { ...s.stepDuration, [stepId]: at - started } : s.stepDuration;
};

/** " in 34s · $0.15 · 5/6 steps" for the final line of a task. */
function summaryTail(s: UiState, e: Extract<SmartEvent, { type: 'task:done' }>): string {
  const parts: string[] = [];
  if (e.at !== undefined && s.taskStartedAt !== undefined) parts.push(`in ${fmtDuration(e.at - s.taskStartedAt)}`);
  if (e.totals.costUsd > 0) parts.push(fmtCost(e.totals.costUsd));
  const total = s.plan?.steps.filter((st) => !st.skipped).length ?? 0;
  if (total > 1) parts.push(`${Object.values(s.stepStatus).filter((v) => v === 'done').length}/${total} steps`);
  return parts.length ? ` ${parts.join(' · ')}` : '.';
}

/** Adds a line of user input to the log (dispatched by the App, not the pipeline). */
export type UiAction = SmartEvent | { type: 'ui:user'; text: string } | { type: 'ui:info'; text: string };

/** Pure reducer: pipeline events in, screen state out. */
export function reduce(s: UiState, e: UiAction): UiState {
  switch (e.type) {
    case 'ui:user':
      return push(s, 'user', e.text);
    case 'ui:info':
      return push(s, 'info', e.text);
    case 'task:start':
      return push(
        {
          ...s, phase: 'running', prompt: e.prompt, dryRun: e.dryRun, stages: initialStages(), classification: undefined, classifyReason: undefined,
          plan: undefined, routes: {}, stepStatus: {}, stepAttempt: {}, escalatedTo: {}, currentStepId: undefined, ok: undefined,
          sessionAtTaskStart: s.session, taskStartedAt: e.at, stepStartedAt: {}, stepDuration: {},
        },
        'info', e.dryRun ? 'Dry run: classify and plan only, nothing will execute.' : 'Task started.',
      );
    case 'stage':
      return {
        ...s,
        stages: { ...s.stages, [e.stage]: e.status },
        phase: e.stage === 'approve' && e.status === 'active' ? 'approval' : e.stage === 'approve' && s.phase === 'approval' ? 'running' : s.phase,
      };
    case 'notice':
      return push(s, e.level === 'warn' ? 'warn' : 'info', e.message);
    case 'classified':
      return push({ ...s, classification: e.classification, classifyReason: e.route.reason }, 'info', `Classified as ${e.classification.complexity}: ${e.classification.reason}`);
    case 'plan:ready': {
      const stepStatus = Object.fromEntries(e.plan.steps.map((st) => [st.id, 'pending' as StepStatus]));
      return push({ ...s, plan: e.plan, routes: e.routes, stepStatus }, 'info', `Plan ready: ${e.plan.steps.length} step${e.plan.steps.length === 1 ? '' : 's'}.`);
    }
    case 'plan:approved': {
      const stepStatus = { ...s.stepStatus };
      for (const st of e.plan.steps) if (st.skipped) stepStatus[st.id] = 'skipped';
      return { ...s, plan: e.plan, stepStatus };
    }
    case 'step:start':
      return push(
        {
          ...s, currentStepId: e.stepId, routes: { ...s.routes, [e.stepId]: e.route },
          stepStartedAt: e.at !== undefined && s.stepStartedAt[e.stepId] === undefined ? { ...s.stepStartedAt, [e.stepId]: e.at } : s.stepStartedAt,
          stepStatus: { ...s.stepStatus, [e.stepId]: 'active' }, stepAttempt: { ...s.stepAttempt, [e.stepId]: e.attempt },
        },
        'info', `▶ ${e.title} [${e.route.tier}${e.attempt > 1 ? `, attempt ${e.attempt}` : ''}]`, e.stepId,
      );
    case 'step:output':
      return push(s, e.kind, e.text, e.stepId);
    case 'tokens':
      return { ...s, session: e.sessionTotal };
    case 'step:verify':
      return push({ ...s, stepStatus: { ...s.stepStatus, [e.stepId]: 'verifying' } }, e.ok ? 'verify-ok' : 'verify-fail', e.ok ? `✓ ${e.command}` : `✗ ${e.command}\n${e.output}`, e.stepId);
    case 'step:escalate':
      return push({ ...s, escalatedTo: { ...s.escalatedTo, [e.stepId]: e.to } }, 'warn', `↑ Escalating ${e.from} → ${e.to} (${e.reason})`, e.stepId);
    case 'step:done':
      return { ...s, stepStatus: { ...s.stepStatus, [e.stepId]: 'done' }, stepDuration: withDuration(s, e.stepId, e.at) };
    case 'step:failed':
      return push(
        { ...s, stepStatus: { ...s.stepStatus, [e.stepId]: e.error === 'Cancelled' ? 'cancelled' : 'failed' }, stepDuration: withDuration(s, e.stepId, e.at) },
        e.error === 'Cancelled' ? 'warn' : 'error', e.error === 'Cancelled' ? 'Step cancelled.' : `Step failed: ${e.error}`, e.stepId,
      );
    case 'task:done':
      return push({ ...s, phase: 'finished', ok: e.ok }, e.ok ? 'info' : 'error', `${e.ok ? '✓ Done' : '✗ Task did not complete'}${summaryTail(s, e)}`);
    case 'conversation':
      return { ...s, chatTasks: e.tasks };
    case 'task:cancelled':
      return push({ ...s, phase: 'finished', ok: false }, 'warn', 'Cancelled.');
    case 'error':
      return push({ ...s, phase: 'finished', ok: false }, 'error', e.hint ? `${e.message}\n${e.hint}` : e.message);
    default:
      return s;
  }
}

/** Cost/tokens of the current task, derived from the session totals. */
export function taskUsage(s: UiState): Usage {
  const a = s.session;
  const b = s.sessionAtTaskStart;
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens - b.cacheCreationTokens,
    costUsd: a.costUsd - b.costUsd,
  };
}
