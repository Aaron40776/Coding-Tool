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
      /**
       * Once the Claude Code session has grown past this many tokens, the next task starts a fresh one with a summary of the
       * conversation: every turn of every step re-reads the whole session, so a long chat makes each step cost more. 0 = never.
       */
      maxContextTokens: z.number().int().min(0).default(80_000),
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
      /** Keep one `claude` process running per conversation for coding steps, so a step does not wait for Claude Code to start. */
      keepAlive: z.boolean().default(true),
      /** Pick the thinking effort per step from the task (cheap for easy work, more for hard). An explicit `effort` below wins. */
      autoEffort: z.boolean().default(true),
      extraArgs: z.array(z.string()).default([]),
      /** Optional `--effort` level per model tier, e.g. { "haiku": "low", "opus": "high" }. Unset = Claude Code default. */
      effort: z.object({ haiku: effort.optional(), sonnet: effort.optional(), opus: effort.optional() }).default({}),
    })
    .prefault({}),
  verify: z
    .object({
      auto: z.boolean().default(true),
      commands: z.array(z.string()).default([]),
      timeoutSec: z.number().int().min(5).default(300),
      /** Run the detected `test` script after every plan step. Off: earlier steps get the quick checks, the last step the tests too. */
      testEveryStep: z.boolean().default(false),
    })
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

/** Your own config for every project. */
export const globalConfigPath = (home: string = homedir()): string => join(home, '.smart', 'smart.config.json');

export interface LoadedConfig {
  config: SmartConfig;
  /** The highest-priority file that was read (the project's, else your global one), or null when defaults are used. */
  source: string | null;
  /** Every file that was read, lowest priority first: your global config, then the project's (or `--config`). */
  sources: string[];
  /** Things worth telling the user: unknown (probably misspelled) keys, and risky settings in a project-local file. */
  warnings: string[];
}

/** Settings that used to exist: still accepted silently so old config files do not warn. */
const REMOVED_KEYS = new Set(['pricing']);
/** JSON has no comments, so `"//": "..."` (and `$schema`) are allowed anywhere as notes. */
const isNote = (k: string): boolean => k.startsWith('//') || k.startsWith('$');

function unknownKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = defaultConfig() as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (REMOVED_KEYS.has(k) || isNote(k)) continue;
    if (!(k in known)) {
      out.push(k);
      continue;
    }
    const section = known[k];
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof section === 'object' && section !== null && !Array.isArray(section)) {
      for (const sub of Object.keys(v)) if (!isNote(sub) && !(sub in (section as Record<string, unknown>))) out.push(`${k}.${sub}`);
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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `over` on top of `base`: objects merge key by key, anything else (values, arrays, null) replaces. */
export function mergeConfig(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeConfig(base[k], v);
  return out;
}

function readConfigFile(path: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SmartError('config', `Could not parse ${path}: ${(e as Error).message}`);
  }
  // Each file must be valid on its own, so an error names the file it is in.
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SmartError('config', `Invalid config in ${path}: ${issues}`);
  }
  return raw;
}

/**
 * Your global `~/.smart/smart.config.json`, then the project's `./smart.config.json` (or `--config <path>`) on top: a
 * project file changes only the keys it sets, the rest of your own settings still apply.
 */
export function loadConfig(cwd: string, explicitPath?: string, home: string = homedir()): LoadedConfig {
  const project = explicitPath ? resolve(cwd, explicitPath) : join(cwd, 'smart.config.json');
  if (explicitPath && !existsSync(project)) throw new SmartError('config', `Config file not found: ${explicitPath}`);
  const sources = [...new Set([globalConfigPath(home), project])].filter((p) => existsSync(p));
  if (sources.length === 0) return { config: defaultConfig(), source: null, sources: [], warnings: [] };

  const warnings: string[] = [];
  let merged: unknown = {};
  for (const path of sources) {
    const raw = readConfigFile(path);
    const unknown = unknownKeys(raw);
    if (unknown.length) warnings.push(`${path}: ignoring unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (a typo?)`);
    // A config that came with the repository runs with your permissions: say so when it runs commands or passes flags.
    if (path === project && !explicitPath && path !== globalConfigPath(home)) {
      const risky = riskyProjectSettings(ConfigSchema.parse(raw));
      if (risky.length) warnings.push(`This directory's smart.config.json sets ${risky.join(' and ')}. Only run smart here if you trust this project.`);
    }
    merged = mergeConfig(merged, raw);
  }
  return { config: ConfigSchema.parse(merged), source: sources.at(-1) ?? null, sources, warnings };
}
