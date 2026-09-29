export type Complexity = 'trivial' | 'small_edit' | 'multi_file' | 'large_build';
export const COMPLEXITIES: readonly Complexity[] = ['trivial', 'small_edit', 'multi_file', 'large_build'];

export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export const TIERS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus'];

export interface Classification {
  complexity: Complexity;
  needsPlan: boolean;
  reason: string;
  /** How much reasoning the task needs, independent of its size. `hard` single tasks go straight to Opus. */
  difficulty?: 'easy' | 'normal' | 'hard';
  /** A complete answer to a pure question that needs no project files, tools or current information. */
  answer?: string;
  /** True when the classifier output was unusable and defaults were applied. */
  fallback?: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  instructions: string;
  files: string[];
  acceptance: string[];
  skipped?: boolean;
  /** Per-step model tier chosen by the user in the approval screen. */
  tier?: ModelTier;
}

export interface Plan {
  summary: string;
  features: string[];
  fileStructure: string[];
  steps: PlanStep[];
}

export interface RouteDecision {
  tier: ModelTier;
  /** Which rule decided: lets callers know whether the choice was the user's or automatic. */
  source?: 'override' | 'step' | 'keyword' | 'fallback' | 'complexity' | 'session';
  /** Concrete model name, read from config. */
  model: string;
  reason: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** One rolling usage window of the Claude account (e.g. the 5-hour and 7-day limits). */
export interface LimitWindow {
  /** 0..1 share of the window's allowance already used. */
  utilization: number;
  /** Epoch seconds when the window resets. */
  resetsAt?: number;
}

export interface Limits {
  windows: Record<string, LimitWindow>;
  /** Claude's own verdict, e.g. "allowed", "allowed_warning", "rejected". */
  status?: string;
  /** Epoch ms when this was observed. */
  at: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  costUsd: a.costUsd + b.costUsd,
});
