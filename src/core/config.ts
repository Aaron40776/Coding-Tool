import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { SmartError } from './errors.js';

const tier = z.enum(['haiku', 'sonnet', 'opus']);

const ConfigSchema = z.object({
  models: z
    .object({ haiku: z.string().min(1), sonnet: z.string().min(1), opus: z.string().min(1) })
    .prefault({ haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }),
  routing: z
    .object({
      trivial: tier.default('haiku'),
      small_edit: tier.default('sonnet'),
      multi_file: tier.default('sonnet'),
      large_build: tier.default('sonnet'),
      planner: tier.default('opus'),
      classifier: tier.default('haiku'),
      keywordRules: z.array(z.object({ match: z.string().min(1), tier })).default([
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
      maxPlanSteps: z.number().int().min(1).max(30).default(8),
      maxContextBytes: z.number().int().min(0).default(40_000),
      maxBudgetUsdPerStep: z.number().positive().nullable().default(null),
    })
    .prefault({}),
  runner: z
    .object({
      permissionMode: z
        .enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
        .default('bypassPermissions'),
      bare: z.boolean().default(false),
      extraArgs: z.array(z.string()).default([]),
    })
    .prefault({}),
  verify: z
    .object({ auto: z.boolean().default(true), commands: z.array(z.string()).default([]) })
    .prefault({}),
  trackerPath: z.string().default('~/.smart/history.json'),
});

export type SmartConfig = z.infer<typeof ConfigSchema>;

export const defaultConfig = (): SmartConfig => ConfigSchema.parse({});

export const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p));

/** Candidate config locations, highest priority first. */
export const configPaths = (cwd: string): string[] => [
  join(cwd, 'smart.config.json'),
  join(homedir(), '.smart', 'smart.config.json'),
];

export interface LoadedConfig {
  config: SmartConfig;
  /** Path the config was read from, or null when defaults are used. */
  source: string | null;
}

export function loadConfig(cwd: string, explicitPath?: string): LoadedConfig {
  const candidates = explicitPath ? [resolve(cwd, explicitPath)] : configPaths(cwd);
  const source = candidates.find((p) => existsSync(p)) ?? null;
  if (explicitPath && !source) throw new SmartError('config', `Config file not found: ${explicitPath}`);
  if (!source) return { config: defaultConfig(), source: null };

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
  return { config: parsed.data, source };
}
