import type { ModelTier, Usage } from '../core/types.js';

export const fmtCost = (usd: number): string => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(usd >= 10 ? 1 : 2)}`);

export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** Fresh input + output tokens; cache reads are shown separately because they dominate and cost ~10%. */
export const billableTokens = (u: Usage): number => u.inputTokens + u.cacheCreationTokens + u.outputTokens;

export const tierLabel = (t: ModelTier | string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '?');
