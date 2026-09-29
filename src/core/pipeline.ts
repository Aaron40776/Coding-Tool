import { randomUUID } from 'node:crypto';
import type { RunClaudeFn } from './claude.js';
import { resolvePermissionMode } from './claude.js';
import { classify } from './classifier.js';
import type { SmartConfig } from './config.js';
import { newConversation, recordTask, renderMemory, type Conversation, type ConversationStore } from './conversation.js';
import { EventBus, type Stage } from './events.js';
import { SmartError, cancelled, isCancelled } from './errors.js';
import { projectFiles } from './files.js';
import { makePlan, singleStepPlan } from './planner.js';
import { applyWarmCache, route } from './router.js';
import { runStep } from './runner.js';
import type { StepOutcome, StepRecord, TaskRecord, Tracker } from './tracker.js';
import { addUsage, emptyUsage, type Classification, type ModelTier, type Plan, type PlanStep, type RouteDecision, type Usage } from './types.js';
import { detectChecks, nextAttempt, runChecks, type ExecFn } from './verifier.js';

export interface PipelineDeps {
  run: RunClaudeFn;
  exec?: ExecFn;
  tracker?: Tracker;
  listFiles?: (cwd: string) => string[];
  now?: () => Date;
  /** Effective uid, injectable so the root fallback is testable. */
  uid?: number;
  /** Conversation to continue (`smart -c`); a new one is started when omitted. */
  conversation?: Conversation;
  conversationStore?: ConversationStore;
}

export interface TaskOptions {
  dryRun?: boolean;
  noPlan?: boolean;
  /** Skip the approval pause (non-interactive use and tests). */
  autoApprove?: boolean;
}

export interface TaskSummary {
  taskId: string;
  ok: boolean;
  cancelled: boolean;
  dryRun: boolean;
  totals: Usage;
  steps: StepRecord[];
  classification?: Classification;
  plan?: Plan;
}

/**
 * Orchestrates classify → plan → approve → execute → verify. It only talks to the outside
 * world through `deps` and the event bus, so any frontend can drive it.
 */
export class Pipeline {
  private forced: ModelTier | null = null;
  private dryRun = false;
  private running = false;
  private sessionDone: Usage = emptyUsage();
  private taskUsage: Usage = emptyUsage();
  private ctl: AbortController | null = null;
  private approval: { resolve: (p: Plan) => void; reject: (e: Error) => void } | null = null;
  private announced = false;
  private conv: Conversation;
  private lastReply = '';

  constructor(
    private readonly config: SmartConfig,
    readonly bus: EventBus,
    private readonly cwd: string,
    private readonly deps: PipelineDeps,
  ) {
    this.conv = deps.conversation ?? newConversation();
  }

  // ---- commands from the frontend -------------------------------------------------------

  forceModel(tier: ModelTier | null): void {
    this.forced = tier;
  }
  setDryRun(on: boolean): void {
    this.dryRun = on;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get sessionTotal(): Usage {
    return addUsage(this.sessionDone, this.taskUsage);
  }
  /** Number of tasks remembered in the current conversation. */
  get chatTasks(): number {
    return this.conv.tasks.length;
  }

  /** Forget the conversation: the next task starts a fresh Claude Code session with no memory. */
  newConversation(): void {
    if (this.running) throw new SmartError('internal', 'Cancel the running task before starting a new conversation.');
    this.conv = newConversation();
    this.saveConversation();
    this.emitConversation();
  }

  /** Resolve the pending plan-approval pause with the (possibly edited) plan. */
  approvePlan(plan: Plan): void {
    this.approval?.resolve(plan);
  }

  /** Cancel whatever is running: the current Claude call, verification, or the approval pause. */
  cancel(): void {
    this.ctl?.abort();
    this.approval?.reject(cancelled());
  }

  // ---- the task ---------------------------------------------------------------------------

  async runTask(prompt: string, opts: TaskOptions = {}): Promise<TaskSummary> {
    if (this.running) throw new SmartError('internal', 'A task is already running.');
    this.running = true;
    this.ctl = new AbortController();
    this.taskUsage = emptyUsage();
    const dryRun = opts.dryRun ?? this.dryRun;
    const taskId = `t_${(this.deps.now?.() ?? new Date()).getTime().toString(36)}`;
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const summary: TaskSummary = { taskId, ok: false, cancelled: false, dryRun, totals: emptyUsage(), steps: [] };
    let overhead = emptyUsage();
    const touched: string[] = [];
    this.lastReply = '';

    const emit = this.bus.emit.bind(this.bus);
    const stage = (s: Stage, status: 'active' | 'done' | 'skipped' | 'failed') => emit({ type: 'stage', stage: s, status });
    let current: Stage = 'classify';
    const at = (s: Stage) => {
      current = s;
      stage(s, 'active');
    };

    try {
      emit({ type: 'task:start', taskId, prompt, dryRun, at: this.now() });
      this.emitConversation();
      this.announce();
      const memory = renderMemory(this.conv);
      const signal = this.ctl.signal;

      // 1. classify
      at('classify');
      const c = await classify(prompt, { config: this.config, cwd: this.cwd, run: this.deps.run, signal, memory });
      overhead = addUsage(overhead, c.usage);
      this.addCallUsage(c.usage);
      const classification = c.classification;
      summary.classification = classification;
      emit({ type: 'classified', classification, route: this.routeTask(classification, prompt) });
      if (classification.fallback) emit({ type: 'notice', level: 'warn', message: classification.reason });
      stage('classify', 'done');

      // 2. plan
      const wantPlan = !opts.noPlan && (classification.needsPlan || classification.complexity === 'large_build');
      let plan: Plan;
      if (wantPlan) {
        at('plan');
        const p = await makePlan(prompt, classification, {
          config: this.config, cwd: this.cwd, run: this.deps.run, signal, override: this.forced, memory,
          projectFiles: (this.deps.listFiles ?? projectFiles)(this.cwd),
        });
        overhead = addUsage(overhead, p.usage);
        this.addCallUsage(p.usage);
        plan = p.plan;
        if (p.warning) emit({ type: 'notice', level: 'warn', message: p.warning });
        stage('plan', 'done');
      } else {
        plan = singleStepPlan(prompt);
        stage('plan', 'skipped');
      }
      summary.plan = plan;
      emit({ type: 'plan:ready', plan, routes: this.routePlan(plan, classification) });

      if (dryRun) {
        stage('approve', 'skipped');
        stage('execute', 'skipped');
        stage('verify', 'skipped');
        summary.ok = true;
        return await this.finish(summary, { overhead, startedAt, prompt, touched });
      }

      // 3. approve (only for multi-step plans the planner produced)
      if (wantPlan && plan.steps.length > 1 && !opts.autoApprove) {
        at('approve');
        plan = await this.awaitApproval();
        summary.plan = plan;
        emit({ type: 'plan:approved', plan });
        stage('approve', 'done');
      } else {
        stage('approve', 'skipped');
      }

      // 4. execute (+ verify per step)
      at('execute');
      const active = plan.steps.filter((s) => !s.skipped);
      let failed = false;
      for (const [index, step] of active.entries()) {
        const rec = await this.runOneStep({ plan, step, index, total: active.length, classification, touched, current: (s) => at(s) });
        summary.steps.push(rec);
        if (rec.outcome !== 'done') {
          failed = true;
          if (rec.outcome === 'cancelled') throw cancelled();
          break;
        }
      }
      for (const s of plan.steps.filter((s) => s.skipped)) summary.steps.push(skippedRecord(s));
      summary.ok = !failed;
      stage('execute', failed ? 'failed' : 'done');
      return await this.finish(summary, { overhead, startedAt, prompt, touched });
    } catch (e) {
      if (isCancelled(e)) {
        summary.cancelled = true;
        stage(current, 'failed');
        emit({ type: 'task:cancelled', taskId });
      } else {
        const err = e instanceof SmartError ? e : new SmartError('internal', (e as Error).message ?? String(e));
        stage(current, 'failed');
        emit({ type: 'error', kind: err.kind, message: err.message, hint: err.hint });
      }
      summary.ok = false;
      return await this.finish(summary, { overhead, startedAt, prompt, touched, aborted: true });
    } finally {
      this.running = false;
      this.ctl = null;
      this.approval = null;
    }
  }

  // ---- internals --------------------------------------------------------------------------

  private announce(): void {
    if (this.announced) return;
    this.announced = true;
    const perm = resolvePermissionMode(this.config.runner.permissionMode, this.deps.uid ?? process.getuid?.());
    if (perm.warning) this.bus.emit({ type: 'notice', level: 'warn', message: perm.warning });
    else if (perm.mode === 'bypassPermissions') {
      this.bus.emit({ type: 'notice', level: 'warn', message: `Permissions are bypassed: Claude Code can run any command in ${this.cwd}.` });
    }
  }

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /**
   * Follow-up tasks avoid downgrading to a model with a cold cache (see applyWarmCache). Within one
   * task every step is routed on its own merits, so a single escalated step cannot drag the rest up.
   */
  private warm(decision: RouteDecision): RouteDecision {
    const followUp = this.conv.tasks.length > 0 && this.conv.sessionId !== null;
    return this.config.session.resume && followUp ? applyWarmCache(decision, this.conv, this.now(), this.config) : decision;
  }

  private emitConversation(): void {
    this.bus.emit({ type: 'conversation', tasks: this.conv.tasks.length, resumed: this.conv.sessionId !== null });
  }

  private saveConversation(): void {
    const err = this.deps.conversationStore?.save(this.cwd, this.conv);
    if (err) this.bus.emit({ type: 'notice', level: 'warn', message: err });
  }

  private routeTask(classification: Classification, text: string): RouteDecision {
    return this.warm(route({ classification, text, override: this.forced }, this.config));
  }

  private routePlan(plan: Plan, classification: Classification): Record<string, RouteDecision> {
    return Object.fromEntries(plan.steps.map((s) => [s.id, this.routeStep(s, classification)]));
  }

  private routeStep(step: PlanStep, classification: Classification): RouteDecision {
    return this.warm(route({ classification, text: `${step.title}\n${step.instructions}`, step, override: this.forced }, this.config));
  }

  private awaitApproval(): Promise<Plan> {
    return new Promise<Plan>((resolve, reject) => {
      if (this.ctl?.signal.aborted) return reject(cancelled());
      this.approval = { resolve, reject };
    }).finally(() => {
      this.approval = null;
    });
  }

  private addCallUsage(usage: Usage): void {
    this.taskUsage = addUsage(this.taskUsage, usage);
    this.bus.emit({ type: 'tokens', usage, sessionTotal: this.sessionTotal });
  }

  private async runOneStep(a: {
    plan: Plan;
    step: PlanStep;
    index: number;
    total: number;
    classification: Classification;
    touched: string[];
    current: (s: Stage) => void;
  }): Promise<StepRecord> {
    const { plan, step, index, total, classification, touched } = a;
    const emit = this.bus.emit.bind(this.bus);
    const signal = this.ctl!.signal;
    const perm = resolvePermissionMode(this.config.runner.permissionMode, this.deps.uid ?? process.getuid?.());
    const first = this.routeStep(step, classification);
    const rec: StepRecord = { stepId: step.id, title: step.title, model: first.model, tier: first.tier, attempts: 0, escalated: false, usage: emptyUsage(), outcome: 'failed' };

    let tier = first.tier;
    let failuresOnTier = 0;
    let failure: string | undefined;
    let decision = first;

    for (;;) {
      const cap = this.config.limits.maxBudgetUsdPerTask;
      if (cap && this.taskUsage.costUsd >= cap) {
        rec.outcome = 'failed';
        const msg = `Task budget of $${cap} reached (spent $${this.taskUsage.costUsd.toFixed(2)}); stopping.`;
        emit({ type: 'notice', level: 'warn', message: msg });
        emit({ type: 'step:failed', stepId: step.id, error: msg });
        return rec;
      }
      rec.attempts += 1;
      rec.tier = tier;
      rec.model = decision.model;
      emit({ type: 'stage', stage: 'verify', status: 'pending' });
      emit({ type: 'step:start', stepId: step.id, title: step.title, route: decision, attempt: rec.attempts, at: this.now() });
      a.current('execute');

      // One persisted Claude Code session per conversation: steps and follow-up tasks resume it.
      const resuming = this.config.session.resume && this.conv.sessionId !== null;
      const sessionId = this.config.session.resume ? (this.conv.sessionId ?? randomUUID()) : undefined;
      const memory = !resuming && index === 0 ? renderMemory(this.conv) : '';

      let ok = false;
      try {
        const res = await runStep({
          plan, step, index, total, touchedFiles: touched, failure, memory: memory || undefined,
          session: sessionId ? { id: sessionId, resume: resuming } : undefined,
          effort: this.config.runner.effort[tier],
          config: this.config, cwd: this.cwd, run: this.deps.run, route: decision, permissionMode: perm.mode, signal,
          onOutput: (kind, text) => {
            if (kind === 'text') this.lastReply = text;
            emit({ type: 'step:output', stepId: step.id, kind, text });
          },
          onProgress: (p) => emit({
            type: 'tokens', stepId: step.id,
            usage: { ...emptyUsage(), inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheReadTokens: p.cacheReadTokens },
            sessionTotal: addUsage(this.sessionTotal, { ...emptyUsage(), inputTokens: p.inputTokens, outputTokens: p.outputTokens }),
          }),
        });
        if (res.text.trim()) this.lastReply = res.text; // the final message is authoritative for follow-up memory
        rec.usage = addUsage(rec.usage, res.usage);
        this.taskUsage = addUsage(this.taskUsage, res.usage);
        emit({ type: 'tokens', stepId: step.id, usage: res.usage, sessionTotal: this.sessionTotal });
        for (const f of res.touched) if (!touched.includes(f)) touched.push(f);
        if (sessionId) this.conv.sessionId = sessionId;
        this.conv.lastTier = tier;
        this.conv.lastCallAt = this.now();
        this.conv.lastCallAtByTier = { ...this.conv.lastCallAtByTier, [tier]: this.conv.lastCallAt };

        // verify
        const skipVerify = classification.complexity === 'trivial' && res.touched.length === 0;
        const checks = skipVerify ? [] : detectChecks(this.cwd, this.config);
        if (checks.length > 0) a.current('verify');
        const v = await runChecks(checks, {
          cwd: this.cwd, config: this.config, exec: this.deps.exec, signal,
          onCheck: (r) => emit({ type: 'step:verify', stepId: step.id, ...r }),
        });
        if (signal.aborted) throw cancelled();
        emit({ type: 'stage', stage: 'verify', status: checks.length === 0 ? 'skipped' : v.ok ? 'done' : 'failed' });
        a.current('execute');
        if (v.ok) ok = true;
        else failure = `${v.failure?.command} failed:\n${v.failure?.output}`;
      } catch (e) {
        if (isCancelled(e)) {
          rec.outcome = 'cancelled';
          emit({ type: 'step:failed', stepId: step.id, error: 'Cancelled', at: this.now() });
          return rec;
        }
        // The saved Claude Code session is gone (cleaned up, other machine): start a new one, carrying our memory.
        if (e instanceof SmartError && e.kind === 'claude' && resuming && /No conversation found/i.test(e.message)) {
          this.conv.sessionId = null;
          emit({ type: 'notice', level: 'warn', message: 'The previous Claude Code session was not found; starting a new one with a summary of the conversation.' });
          rec.attempts -= 1;
          continue;
        }
        // Auth / missing CLI / internal problems will not fix themselves: abort the task.
        if (e instanceof SmartError && e.kind !== 'claude') throw e;
        failure = (e as Error).message;
      }

      if (ok) {
        rec.outcome = 'done';
        emit({ type: 'step:done', stepId: step.id, at: this.now() });
        return rec;
      }

      failuresOnTier += 1;
      // A forced model is a user decision: retry it, but never silently switch to another.
      const next = this.forced ? (failuresOnTier <= this.config.escalation.retriesPerModel ? ({ action: 'retry', tier } as const) : ({ action: 'give_up' } as const)) : nextAttempt({ tier, failuresOnTier }, this.config);
      if (next.action === 'give_up') {
        rec.outcome = 'failed';
        emit({ type: 'step:failed', stepId: step.id, error: failure ?? 'failed', at: this.now() });
        return rec;
      }
      if (next.action === 'escalate') {
        rec.escalated = true;
        emit({ type: 'step:escalate', stepId: step.id, from: next.from, to: next.tier, reason: `failed ${failuresOnTier}x on ${next.from}` });
        tier = next.tier;
        failuresOnTier = 0;
        decision = { tier, model: this.config.models[tier], reason: `escalated from ${next.from}` };
      }
    }
  }

  private async finish(
    summary: TaskSummary,
    f: { overhead: Usage; startedAt: string; prompt: string; touched: string[]; aborted?: boolean },
  ): Promise<TaskSummary> {
    const { overhead, startedAt, prompt, aborted = false } = f;
    if (!summary.dryRun && summary.steps.some((s) => s.outcome !== 'skipped')) {
      recordTask(this.conv, {
        prompt,
        complexity: summary.classification?.complexity,
        summary: summary.plan && summary.plan.steps.length > 1 ? summary.plan.summary : undefined,
        outcome: summary.cancelled ? 'cancelled' : summary.ok ? 'done' : 'failed',
        files: f.touched,
        reply: this.lastReply,
        at: startedAt,
      });
    }
    this.saveConversation();
    this.emitConversation();
    summary.totals = this.taskUsage;
    this.sessionDone = addUsage(this.sessionDone, this.taskUsage);
    this.taskUsage = emptyUsage();
    if (this.deps.tracker && summary.totals.costUsd + summary.totals.outputTokens > 0) {
      const record: TaskRecord = {
        id: summary.taskId, startedAt, prompt, classification: summary.classification, overhead,
        steps: summary.steps, totals: summary.totals, ok: summary.ok,
      };
      const err = this.deps.tracker.append(record);
      if (err) this.bus.emit({ type: 'notice', level: 'warn', message: err });
    }
    if (!aborted) {
      this.bus.emit({ type: 'stage', stage: 'done', status: summary.ok ? 'done' : 'failed' });
      this.bus.emit({ type: 'task:done', taskId: summary.taskId, totals: summary.totals, ok: summary.ok, at: this.now() });
    }
    return summary;
  }
}

const skippedRecord = (s: PlanStep): StepRecord => ({
  stepId: s.id, title: s.title, model: '-', tier: '-', attempts: 0, escalated: false, usage: emptyUsage(), outcome: 'skipped' as StepOutcome,
});
