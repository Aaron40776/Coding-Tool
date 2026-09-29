import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const slash = (p: string): string => p.split(sep).join('/');
import type { ClaudeStreamEvent, RunClaudeFn } from './claude.js';
import type { SmartConfig } from './config.js';
import type { Plan, PlanStep, RouteDecision, Usage } from './types.js';

export interface FileContext {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Reads the files a step names, within a byte budget. Only files inside `cwd` are read
 * (a plan is model output, so `../../etc/passwd` or a symlink out must not leak into a prompt).
 */
export function gatherFiles(cwd: string, files: string[], maxBytes: number): FileContext[] {
  const out: FileContext[] = [];
  if (maxBytes <= 0) return out;
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return out;
  }
  let budget = maxBytes;
  for (const f of files) {
    if (budget <= 0) break;
    const abs = resolve(cwd, f);
    if (!existsSync(abs)) continue;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, real);
    if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) continue;
    try {
      if (!statSync(real).isFile()) continue;
      const buf = readFileSync(real);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const slice = buf.subarray(0, budget);
      out.push({ path: slash(relative(root, resolve(cwd, f))) || f, content: slice.toString('utf8'), truncated: buf.length > slice.length });
      budget -= slice.length;
    } catch {
      continue;
    }
  }
  return out;
}

export interface StepPromptInput {
  plan: Plan;
  step: PlanStep;
  index: number;
  total: number;
  touchedFiles: string[];
  fileContext: FileContext[];
  /** Verification output from the previous failed attempt, if this is a retry. */
  failure?: string;
}

/** The lean per-step prompt: the step, its acceptance criteria and only the relevant files. No history. */
export function buildStepPrompt(i: StepPromptInput): string {
  const parts: string[] = [];
  const multi = i.total > 1;
  parts.push(multi ? `You are executing step ${i.index + 1} of ${i.total} of a plan. Do only this step.` : 'Complete this task.');
  if (multi) parts.push(`Project goal: ${i.plan.summary}`);
  parts.push(`${multi ? 'Step' : 'Task'}: ${i.step.title}\n${i.step.instructions}`);
  if (i.step.acceptance.length) parts.push('Acceptance criteria:\n' + i.step.acceptance.map((a) => `- ${a}`).join('\n'));
  if (i.touchedFiles.length) parts.push('Files changed in earlier steps: ' + i.touchedFiles.join(', '));
  if (i.fileContext.length) {
    parts.push(
      'Current contents of relevant files:\n' +
        i.fileContext.map((f) => `<file path="${f.path}">\n${f.content}${f.truncated ? '\n[truncated]' : ''}\n</file>`).join('\n'),
    );
  }
  if (i.failure) parts.push(`Your previous attempt failed verification. Fix the cause, do not just re-run:\n<failure>\n${i.failure}\n</failure>`);
  return parts.join('\n\n');
}

export const EXECUTOR_APPEND = 'Be terse: no preamble or recap. Never ask questions; make reasonable assumptions. End with one line saying what you did.';

export interface RunStepOptions extends Omit<StepPromptInput, 'fileContext'> {
  config: SmartConfig;
  cwd: string;
  run: RunClaudeFn;
  route: RouteDecision;
  permissionMode: string;
  signal?: AbortSignal;
  onOutput?: (kind: 'text' | 'tool', text: string) => void;
  onProgress?: (p: { inputTokens: number; outputTokens: number; cacheReadTokens: number }) => void;
}

export interface StepRunResult {
  text: string;
  usage: Usage;
  /** Files Claude Code wrote or edited during this step (paths as reported by the tool). */
  touched: string[];
}

/** Runs one plan step as one headless Claude Code call on the routed model. */
export async function runStep(o: RunStepOptions): Promise<StepRunResult> {
  const fileContext = gatherFiles(o.cwd, o.step.files, o.config.limits.maxContextBytes);
  const prompt = buildStepPrompt({ ...o, fileContext });
  const touched = new Set<string>();

  const onEvent = (e: ClaudeStreamEvent) => {
    if (e.kind === 'text') o.onOutput?.('text', e.text);
    else if (e.kind === 'tool') {
      // Show project-relative paths: absolute ones are long and add no information.
      o.onOutput?.('tool', slash(e.summary.split(`${o.cwd}${sep}`).join('').split(`${o.cwd}/`).join('')));
      if (e.writtenFile) touched.add(slash(relative(o.cwd, resolve(o.cwd, e.writtenFile))) || e.writtenFile);
    } else if (e.kind === 'progress') o.onProgress?.(e);
  };

  const result = await o.run({
    prompt,
    model: o.route.model,
    cwd: o.cwd,
    signal: o.signal,
    appendSystemPrompt: EXECUTOR_APPEND,
    permissionMode: o.permissionMode,
    bare: o.config.runner.bare,
    maxBudgetUsd: o.config.limits.maxBudgetUsdPerStep,
    extraArgs: o.config.runner.extraArgs,
    onEvent,
  });
  return { text: result.text, usage: result.usage, touched: [...touched] };
}
