import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { SmartError } from './errors.js';
import { EFFORTS } from './types.js';

const tier = z.enum(['haiku', 'sonnet', 'opus']);
const effort = z.enum(EFFORTS);

const validRegex = (s: string): boolean => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
};

const ConfigSchema = z.object({
  // Each field has its own default, so overriding one model (`{"models":{"opus":"claude-opus-4-1"}}`) is valid.
  models: z
    .object({ haiku: z.string().min(1).default('haiku'), sonnet: z.string().min(1).default('sonnet'), opus: z.string().min(1).default('opus') })
    .prefault({}),
  routing: z
    .object({
      /**
       * How the rater trades cost against quality: `cost` needs stronger evidence before it uses a bigger model or higher effort,
       * `quality` needs less. The per-complexity tiers below are floors the rater never goes under.
       */
      optimize: z.enum(['cost', 'balanced', 'quality']).default('balanced'),
      /** Skip the classifier call for clearly routine edits ("fix the typo", "rename x"): saves a whole call, about 5 s. */
      fastLane: z.boolean().default(true),
      trivial: tier.default('haiku'),
      small_edit: tier.default('sonnet'),
      multi_file: tier.default('sonnet'),
      large_build: tier.default('sonnet'),
      /** Plans big builds and hard tasks. */
      planner: tier.default('opus'),
      /** Plans everything else that needs a plan (mid-size, multi-part changes): Sonnet is plenty and about 2x cheaper. */
      plannerLight: tier.default('sonnet'),
      classifier: tier.default('haiku'),
      reviewer: tier.default('haiku'),
      keywordRules: z.array(z.object({ match: z.string().min(1).refine(validRegex, 'invalid regular expression'), tier })).default([
        { match: 'architecture|race condition|deadlock', tier: 'opus' },
      ]),
    })
    .prefault({}),
  escalation: z
    .object({
      retriesPerModel: z.number().int().min(0).max(5).default(1),
      ladder: z.array(tier).min(1).default(['haiku', 'sonnet', 'opus']),
    })
    .prefault({}),
  limits: z
    .object({
      maxPlanSteps: z.number().int().min(1).max(30).default(6),
      maxContextBytes: z.number().int().min(0).default(40_000),
      maxBudgetUsdPerStep: z.number().positive().nullable().default(null),
      /** Stop the task once its total cost reaches this many dollars. */
      maxBudgetUsdPerTask: z.number().positive().nullable().default(null),
    })
    .prefault({}),
  session: z
    .object({
      /** Keep one Claude Code session per conversation (--resume) so follow-ups have real history. */
      resume: z.boolean().default(true),
      /** How long Anthropic's prompt cache stays warm after a call; used to decide whether switching models is worth it. */
      cacheTtlSec: z.number().int().min(0).default(300),
      /** While the cache is warm, never downgrade to a cheaper model (it would re-read the history at full price). */
      keepWarmTier: z.boolean().default(true),
    })
    .prefault({}),
  runner: z
    .object({
      permissionMode: z
        .enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
        .default('bypassPermissions'),
      bare: z.boolean().default(false),
      /** Classify, plan and review calls have no tools, so they skip hooks, plugins and MCP servers (faster start-up). */
      leanCalls: z.boolean().default(true),
      /** Pick the thinking effort per step from the task (cheap for easy work, more for hard). An explicit `effort` below wins. */
      autoEffort: z.boolean().default(true),
      extraArgs: z.array(z.string()).default([]),
      /** Optional `--effort` level per model tier, e.g. { "haiku": "low", "opus": "high" }. Unset = Claude Code default. */
      effort: z.object({ haiku: effort.optional(), sonnet: effort.optional(), opus: effort.optional() }).default({}),
    })
    .prefault({}),
  verify: z
    .object({ auto: z.boolean().default(true), commands: z.array(z.string()).default([]), timeoutSec: z.number().int().min(5).default(300) })
    .prefault({}),
  review: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  usage: z
    .object({
      /** Stop automatically choosing Opus once any account usage window reaches this share (0..1). 0 disables. */
      downshiftAt: z.number().min(0).max(1).default(0.9),
      /** Warn once when a window first reaches this share (0..1). 0 disables. */
      warnAt: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
  trackerPath: z.string().default('~/.smart/history.json'),
  conversationsPath: z.string().default('~/.smart/conversations.json'),
  limitsPath: z.string().default('~/.smart/limits.json'),
  historyPath: z.string().default('~/.smart/input-history.json'),
});

export type SmartConfig = z.infer<typeof ConfigSchema>;

export const defaultConfig = (): SmartConfig => ConfigSchema.parse({});

/** `~`, `~/x` and `~\\x` mean the home directory; `~foo` is an ordinary relative name. */
export const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : resolve(p));

/** Candidate config locations, highest priority first. */
export const configPaths = (cwd: string): string[] => [
  join(cwd, 'smart.config.json'),
  join(homedir(), '.smart', 'smart.config.json'),
];

export interface LoadedConfig {
  config: SmartConfig;
  /** Path the config was read from, or null when defaults are used. */
  source: string | null;
  /** Things worth telling the user: unknown (probably misspelled) keys, and risky settings in a project-local file. */
  warnings: string[];
}

/** Keys the schema knows, two levels deep (every key has a default, so the default config lists them all). */
/** Settings that used to exist: still accepted silently so old config files do not warn. */
const REMOVED_KEYS = new Set(['pricing']);

function unknownKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = defaultConfig() as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (REMOVED_KEYS.has(k)) continue;
    if (!(k in known)) {
      out.push(k);
      continue;
    }
    const section = known[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof section === 'object' && section !== null && !Array.isArray(section)) {
      for (const sub of Object.keys(v)) if (!(sub in (section as Record<string, unknown>))) out.push(`${k}.${sub}`);
    }
  }
  return out;
}

/** A project-local config runs with your permissions: say so when it sets anything that executes commands or passes flags to Claude. */
function riskyProjectSettings(config: SmartConfig): string[] {
  const out: string[] = [];
  if (config.verify.commands.length) out.push(`verify.commands (runs: ${config.verify.commands.join('; ')})`);
  if (config.runner.extraArgs.length) out.push(`runner.extraArgs (${config.runner.extraArgs.join(' ')})`);
  return out;
}

export function loadConfig(cwd: string, explicitPath?: string): LoadedConfig {
  const candidates = explicitPath ? [resolve(cwd, explicitPath)] : configPaths(cwd);
  const source = candidates.find((p) => existsSync(p)) ?? null;
  if (explicitPath && !source) throw new SmartError('config', `Config file not found: ${explicitPath}`);
  if (!source) return { config: defaultConfig(), source: null, warnings: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  } catch (e) {
    throw new SmartError('config', `Could not parse ${source}: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SmartError('config', `Invalid config in ${source}: ${issues}`);
  }
  const warnings: string[] = [];
  const unknown = unknownKeys(raw);
  if (unknown.length) warnings.push(`${source}: ignoring unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (a typo?)`);
  if (source === candidates[0] && !explicitPath) {
    const risky = riskyProjectSettings(parsed.data);
    if (risky.length) warnings.push(`This directory's smart.config.json sets ${risky.join(' and ')}. Only run smart here if you trust this project.`);
  }
  return { config: parsed.data, source, warnings };
}
