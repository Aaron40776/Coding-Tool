import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RunClaudeFn } from './claude.js';
import { resolvePermissionMode } from './claude.js';
import { NoCheckpoints, type Changes, type Checkpointer } from './checkpoint.js';
import { classify } from './classifier.js';
import type { SmartConfig } from './config.js';
import { newConversation, recordTask, renderMemory, type Conversation, type ConversationStore } from './conversation.js';
import { EventBus, type Stage } from './events.js';
import { SmartError, cancelled, isCancelled } from './errors.js';
import { projectContext, projectFiles } from './files.js';
import { resolveMentions } from './mentions.js';
import { makePlan, singleStepPlan } from './planner.js';
import { applyWarmCache, route } from './router.js';
import { reviewStep } from './review.js';
import { gatherFiles, runStep } from './runner.js';
import type { StepOutcome, StepRecord, TaskRecord, Tracker } from './tracker.js';
import { addUsage, emptyUsage, type Classification, type Limits, type ModelTier, type Plan, type PlanStep, type RouteDecision, type Usage } from './types.js';
import { applyLimitPressure, fmtReset, LimitsStore, pct, tightest, windowLabel } from './usage.js';
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
  /** Working-tree snapshots for change summaries, /diff and /undo. Defaults to none. */
  checkpoints?: Checkpointer;
  /** Last account usage seen (persisted between runs) and where to save updates. */
  limits?: Limits | null;
  limitsStore?: LimitsStore;
  /** Override how project instructions are read for the planner (tests). */
  projectContext?: (cwd: string) => string;
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
  private overhead: Usage = emptyUsage();
  private undoStack: { prompt: string; start: string; end: string }[] = [];
  private notes: string[] = [];
  private permOverride: string | null = null;
  private warnedNoGit = false;
  private readonly cp: Checkpointer;
  private limits: Limits | null;
  private warnedWindows = new Set<string>();
  /** Every Claude call goes through here so account usage reported in any stream is captured. */
  private readonly run: RunClaudeFn;

  constructor(
    private readonly config: SmartConfig,
    readonly bus: EventBus,
    private readonly cwd: string,
    private readonly deps: PipelineDeps,
  ) {
    this.conv = deps.conversation ?? newConversation();
    this.cp = deps.checkpoints ?? new NoCheckpoints();
    this.limits = deps.limits ?? null;
    this.run = (o) =>
      deps.run({
        ...o,
        onEvent: (e) => {
          if (e.kind === 'limits') this.observeLimits(e.windows, e.status);
          o.onEvent?.(e);
        },
      });
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
  /** Change the permission mode for the rest of this session (`null` returns to the configured one). */
  setPermissionMode(mode: string | null): void {
    this.permOverride = mode;
  }
  get permissionMode(): string {
    return this.permOverride ?? this.config.runner.permissionMode;
  }
  /** The final message of the last coding step (what `smart -p` prints). */
  get lastReplyText(): string {
    return this.lastReply;
  }
  /** Latest account usage windows Claude reported (may be from a previous run). */
  get accountLimits(): Limits | null {
    return this.limits;
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
    this.overhead = emptyUsage();
    const touched: string[] = [];
    let startTree: string | null = null;
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
      const referenced = resolveMentions(this.cwd, prompt, this.config.limits.maxContextBytes);
      if (referenced.length) emit({ type: 'notice', level: 'info', message: `Using ${referenced.length} referenced file${referenced.length === 1 ? '' : 's'}: ${referenced.map((f) => f.path).join(', ')}` });
      if (!dryRun && !this.cp.available && !this.warnedNoGit) {
        this.warnedNoGit = true;
        emit({ type: 'notice', level: 'info', message: 'Not a git repository, so /undo and /diff are unavailable here. Run `git init` to enable them.' });
      }
      startTree = dryRun ? null : await this.cp.snapshot();
      const signal = this.ctl.signal;

      // 1. classify
      at('classify');
      const c = await classify(prompt, { config: this.config, cwd: this.cwd, run: this.run, signal, memory });
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
          config: this.config, cwd: this.cwd, run: this.run, signal, override: this.forced ?? this.plannerDownshift(), memory,
          projectFiles: (this.deps.listFiles ?? projectFiles)(this.cwd), context: (this.deps.projectContext ?? projectContext)(this.cwd), referenced,
        });
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
        return await this.finish(summary, { startedAt, prompt, touched, startTree });
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
      const cursor = { tree: startTree };
      const active = plan.steps.filter((s) => !s.skipped);
      let failed = false;
      for (const [index, step] of active.entries()) {
        const rec = await this.runOneStep({ plan, step, index, total: active.length, classification, touched, current: (s) => at(s), prompt, cursor, referenced });
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
      return await this.finish(summary, { startedAt, prompt, touched, startTree });
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
      return await this.finish(summary, { startedAt, prompt, touched, startTree, aborted: true });
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
    const pressured = applyLimitPressure(decision, this.limits, this.config);
    const followUp = this.conv.tasks.length > 0 && this.conv.sessionId !== null;
    return this.config.session.resume && followUp ? applyWarmCache(pressured, this.conv, this.now(), this.config) : pressured;
  }

  /** While an account usage window is nearly used up, plan with sonnet instead of the (heavier) configured planner model. */
  private plannerDownshift(): ModelTier | null {
    const probe = applyLimitPressure(
      { tier: this.config.routing.planner, model: this.config.models[this.config.routing.planner], reason: 'planner', source: 'complexity' },
      this.limits,
      this.config,
    );
    return probe.tier !== this.config.routing.planner ? probe.tier : null;
  }

  private observeLimits(windows: Limits['windows'], status?: string): void {
    this.limits = { windows, status, at: this.now() };
    this.deps.limitsStore?.save(this.limits);
    this.bus.emit({ type: 'limits', limits: this.limits });
    const warnAt = this.config.usage.warnAt;
    if (!warnAt) return;
    for (const [name, w] of Object.entries(windows)) {
      const level = w.utilization >= 0.95 ? 'critical' : w.utilization >= warnAt ? 'warn' : null;
      if (!level) continue;
      const key = `${name}:${w.resetsAt ?? ''}:${level}`;
      if (this.warnedWindows.has(key)) continue;
      this.warnedWindows.add(key);
      const reset = fmtReset(w.resetsAt, this.now());
      const hint = this.config.usage.downshiftAt && w.utilization >= this.config.usage.downshiftAt ? ' Automatic routing is avoiding Opus until it resets.' : '';
      this.bus.emit({ type: 'notice', level: 'warn', message: `Your ${windowLabel(name)} usage limit is ${pct(w.utilization)} used${reset ? ` (resets in ${reset})` : ''}.${hint}` });
    }
  }

  /** Human-readable effective configuration, for /config. */
  describe(): string[] {
    const c = this.config;
    const r = c.routing;
    const t = tightest(this.limits);
    return [
      `Models: haiku=${c.models.haiku}, sonnet=${c.models.sonnet}, opus=${c.models.opus}`,
      `Routing: trivial→${r.trivial}, small_edit→${r.small_edit}, multi_file→${r.multi_file}, large_build→${r.large_build}; classifier ${r.classifier}, planner ${r.planner}, reviewer ${r.reviewer}`,
      r.keywordRules.length ? `Keyword rules: ${r.keywordRules.map((k) => `/${k.match}/→${k.tier}`).join(', ')}` : 'Keyword rules: none',
      `Escalation: retry ${c.escalation.retriesPerModel}× per model, then ${c.escalation.ladder.join(' → ')}`,
      `Review: ${c.review.enabled ? `on (${r.reviewer})` : 'off'} · Session resume: ${c.session.resume ? 'on' : 'off'} · Warm-cache hold: ${c.session.keepWarmTier ? `on (${c.session.cacheTtlSec}s)` : 'off'}`,
      `Permission mode: ${this.permissionMode}${this.permOverride ? ' (set with /mode)' : ''} · Limits: plan ≤${c.limits.maxPlanSteps} steps, budget/step ${c.limits.maxBudgetUsdPerStep ?? 'none'}, budget/task ${c.limits.maxBudgetUsdPerTask ?? 'none'}`,
      `Usage guard: avoid Opus at ≥${pct(c.usage.downshiftAt)}, warn at ≥${pct(c.usage.warnAt)}${t ? ` (now ${windowLabel(t.name)} ${pct(t.window.utilization)})` : ''}`,
    ];
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

  /** Convert a repository-relative git path to one relative to the project directory (posix separators). */
  private fromRoot(p: string): string {
    return path.posix.relative(this.cp.prefix, p);
  }

  /**
   * The reviewer is the quality gate that works without tests: every plan step is reviewed, and a single-step
   * task is reviewed when no automated check ran. Questions, and steps that changed no files, are not.
   */
  private shouldReview(c: Classification, planSteps: number, checks: number, files: string[]): boolean {
    if (!this.config.review.enabled || c.complexity === 'trivial' || files.length === 0) return false;
    return planSteps > 1 || checks === 0;
  }

  /** Returns a description of the problems, or undefined when the step passes (or could not be reviewed). */
  private async review(task: string, step: PlanStep, files: string[], signal: AbortSignal): Promise<string | undefined> {
    const emit = this.bus.emit.bind(this.bus);
    const contents = gatherFiles(this.cwd, files, this.config.limits.maxContextBytes);
    if (contents.length === 0) return undefined;
    const out = await reviewStep({ task, step, files: contents, config: this.config, cwd: this.cwd, run: this.run, signal });
    this.addCallUsage(out.usage);
    if (out.kind === 'unavailable') {
      emit({ type: 'step:review', stepId: step.id, pass: true, issues: [], skipped: out.reason });
      return undefined;
    }
    emit({ type: 'step:review', stepId: step.id, pass: out.pass, issues: out.issues });
    return out.pass ? undefined : `A review of your changes found problems with this step:\n${out.issues.map((i) => `- ${i}`).join('\n')}`;
  }

  /** Snapshot the end state, publish the change summary and remember it for /undo. Returns changed paths (cwd-relative). */
  private async summarizeChanges(summary: TaskSummary, startTree: string | null, prompt: string): Promise<string[]> {
    if (summary.dryRun || !startTree) return [];
    const end = await this.cp.snapshot();
    if (!end || end === startTree) return [];
    const ch: Changes | null = await this.cp.changes(startTree, end);
    if (!ch || ch.files.length === 0) return [];
    this.undoStack.push({ prompt, start: startTree, end });
    this.undoStack = this.undoStack.slice(-20);
    this.bus.emit({ type: 'changes', files: ch.files.map((f) => ({ ...f, path: this.fromRoot(f.path) })), insertions: ch.insertions, deletions: ch.deletions });
    return ch.files.filter((f) => f.status !== 'D').map((f) => this.fromRoot(f.path));
  }

  /** Revert the working tree to how it was before the most recent task that changed files. */
  async undo(): Promise<void> {
    const emit = this.bus.emit.bind(this.bus);
    if (this.running) return emit({ type: 'notice', level: 'warn', message: 'Cancel the running task (Esc) before undoing.' });
    if (!this.cp.available) return emit({ type: 'notice', level: 'warn', message: 'Undo needs a git repository. Run `git init` in this directory first.' });
    const entry = this.undoStack.pop();
    if (!entry) return emit({ type: 'notice', level: 'info', message: 'Nothing to undo.' });
    const now = await this.cp.snapshot();
    const r = now ? await this.cp.restore(entry.start, now) : null;
    if (!r) {
      this.undoStack.push(entry);
      return emit({ type: 'notice', level: 'warn', message: 'Could not restore the previous state.' });
    }
    const last = [...this.conv.tasks].reverse().find((t) => t.outcome !== 'reverted');
    if (last) last.outcome = 'reverted';
    this.notes.push('The user undid all of your changes from the previous task; the files are back to how they were before it. Do not assume that work exists.');
    this.saveConversation();
    emit({ type: 'notice', level: 'info', message: `Undid "${entry.prompt.length > 50 ? `${entry.prompt.slice(0, 49)}…` : entry.prompt}": restored ${r.restored} and removed ${r.removed} file${r.restored + r.removed === 1 ? '' : 's'}.` });
  }

  /** Publish a unified diff of the most recent task that changed files. */
  async diff(): Promise<void> {
    const emit = this.bus.emit.bind(this.bus);
    if (!this.cp.available) return emit({ type: 'notice', level: 'warn', message: 'Diff needs a git repository. Run `git init` in this directory first.' });
    const entry = this.undoStack.at(-1);
    if (!entry) return emit({ type: 'notice', level: 'info', message: 'No changes to show yet.' });
    const text = await this.cp.diff(entry.start, entry.end);
    emit(text ? { type: 'diff', text } : { type: 'notice', level: 'warn', message: 'Could not compute the diff.' });
  }

  private addCallUsage(usage: Usage): void {
    this.taskUsage = addUsage(this.taskUsage, usage);
    this.overhead = addUsage(this.overhead, usage);
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
    /** The user's overall request (for the reviewer). */
    prompt: string;
    /** Working-tree snapshot before this step; updated to the snapshot after it. */
    cursor: { tree: string | null };
    /** Files the user referenced with @path (given to the first step). */
    referenced: import('./runner.js').FileContext[];
  }): Promise<StepRecord> {
    const { plan, step, index, total, classification, touched } = a;
    const stepStart = a.cursor.tree;
    const emit = this.bus.emit.bind(this.bus);
    const signal = this.ctl!.signal;
    const perm = resolvePermissionMode(this.permissionMode, this.deps.uid ?? process.getuid?.());
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
      const note = index === 0 ? this.notes.join(' ') : '';

      let ok = false;
      try {
        const res = await runStep({
          plan, step, index, total, touchedFiles: touched, failure, memory: memory || undefined, note: note || undefined, referenced: index === 0 ? a.referenced : undefined,
          session: sessionId ? { id: sessionId, resume: resuming } : undefined,
          effort: this.config.runner.effort[tier],
          config: this.config, cwd: this.cwd, run: this.run, route: decision, permissionMode: perm.mode, signal,
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
        if (note) this.notes = [];
        // What actually changed on disk (catches files made by shell commands), plus what the tool events reported.
        const after = await this.cp.snapshot();
        const stepChanges = stepStart && after ? await this.cp.changes(stepStart, after) : null;
        const changedNow = stepChanges ? stepChanges.files.filter((f) => f.status !== 'D').map((f) => this.fromRoot(f.path)) : [];
        const stepFiles = [...new Set([...changedNow, ...res.touched])];
        for (const f of stepFiles) if (!touched.includes(f)) touched.push(f);
        if (after) a.cursor.tree = after;
        if (sessionId) this.conv.sessionId = sessionId;
        this.conv.lastTier = tier;
        this.conv.lastCallAt = this.now();
        this.conv.lastCallAtByTier = { ...this.conv.lastCallAtByTier, [tier]: this.conv.lastCallAt };

        // verify
        const skipVerify = classification.complexity === 'trivial' && stepFiles.length === 0;
        const checks = skipVerify ? [] : detectChecks(this.cwd, this.config);
        if (checks.length > 0) a.current('verify');
        const v = await runChecks(checks, {
          cwd: this.cwd, config: this.config, exec: this.deps.exec, signal,
          onCheck: (r) => emit({ type: 'step:verify', stepId: step.id, ...r }),
        });
        if (signal.aborted) throw cancelled();
        // This attempt's own problem (`failure` still holds the previous attempt's text, which was already sent to the model).
        let problem: string | undefined = v.ok ? undefined : `${v.failure?.command} failed:\n${v.failure?.output}`;
        let reviewed = false;
        if (v.ok && this.shouldReview(classification, plan.steps.length, checks.length, stepFiles)) {
          a.current('verify');
          problem = await this.review(a.prompt, step, stepFiles, signal);
          reviewed = true;
        }
        emit({ type: 'stage', stage: 'verify', status: checks.length === 0 && !reviewed ? 'skipped' : problem ? 'failed' : 'done' });
        a.current('execute');
        if (problem) failure = problem;
        else ok = true;
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
    f: { startedAt: string; prompt: string; touched: string[]; startTree: string | null; aborted?: boolean },
  ): Promise<TaskSummary> {
    const { startedAt, prompt, aborted = false } = f;
    const overhead = this.overhead;
    const changed = await this.summarizeChanges(summary, f.startTree, prompt);
    if (!summary.dryRun && summary.steps.some((s) => s.outcome !== 'skipped')) {
      recordTask(this.conv, {
        prompt,
        complexity: summary.classification?.complexity,
        summary: summary.plan && summary.plan.steps.length > 1 ? summary.plan.summary : undefined,
        outcome: summary.cancelled ? 'cancelled' : summary.ok ? 'done' : 'failed',
        files: changed.length > 0 ? changed : f.touched,
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
