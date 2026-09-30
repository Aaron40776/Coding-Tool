/**
 * Local, free, instant signals about how demanding a piece of work is, read straight from its text.
 * They never call a model. The rater blends them with the classifier's opinion, so a single wrong guess by a
 * cheap model cannot send a deadlock hunt to Haiku or a typo fix to Opus.
 */
export interface Signal {
  label: string;
  /** Added to the score: positive = harder, negative = easier. */
  weight: number;
}

export interface Features {
  /** A plan step: its length and its number of parts say nothing about difficulty (a plan is already broken down, and wordy by design). */
  step: boolean;
  words: number;
  files: number;
  criteria: number;
  parts: number;
  hard: Signal[];
  easy: Signal[];
}

interface Rule {
  label: string;
  re: RegExp;
  weight: number;
}

/** Work that needs careful reasoning whatever its size. */
const HARD: Rule[] = [
  { label: 'concurrency', re: /\b(race conditions?|deadlocks?|livelocks?|mutex(es)?|semaphores?|thread[- ]?safe\w*|concurren\w+|lock contention|atomic(ity)?|data races?)\b/i, weight: 0.3 },
  { label: 'security', re: /\b(security|vulnerabilit\w+|exploit\w*|injection|xss|csrf|oauth|jwt|encrypt\w*|crypto\w*|authenticat\w+|authoriz\w+|sanitiz\w+|permissions?)\b/i, weight: 0.22 },
  { label: 'architecture', re: /\b(architect\w+|redesign\w*|re-?architect\w*|restructur\w+|monolith\w*|microservices?|from scratch|design (a|the) (system|api|schema|data model))\b/i, weight: 0.22 },
  { label: 'algorithms', re: /\b(algorithms?|dynamic programming|graph (search|traversal)|parser|compiler|interpreter|scheduler|consensus|cache invalidation|big-?o|time complexity)\b/i, weight: 0.2 },
  { label: 'investigation', re: /\b(intermittent\w*|flaky|sometimes|randomly|root cause|can'?t reproduce|regression|not sure why|unexpected(ly)?|why (does|is|are|do|did)\b)/i, weight: 0.18 },
  { label: 'cross-cutting', re: /\b(across (the|all|every)|entire (code ?base|project|app|repo)|every (file|module|component|endpoint)|all (files|modules|usages|call ?sites))\b/i, weight: 0.18 },
  { label: 'data migration', re: /\b(migrat\w+|schema changes?|transactions?|backfill\w*|data loss)\b/i, weight: 0.16 },
  { label: 'performance', re: /\b(performance|memory leaks?|profil(e|ing)|latency|throughput|bottleneck|slow|optimi[sz]\w+)\b/i, weight: 0.2 },
];

/** Routine, low-risk changes. */
const EASY: Rule[] = [
  { label: 'trivial edit', re: /\b(typos?|spelling|renam\w+|comments?|docstrings?|log(ging)? (line|statement|message)|console\.log|bump\w*|version number|wording|copy( text)?|labels?|colou?rs?|fonts?|padding|margins?|whitespace|formatting|lint (error|warning)s?|unused (import|variable|code)s?)\b/i, weight: -0.2 },
  { label: 'small scope', re: /\b(one[- ]liner|one[- ]line|single line|quick(ly)?|simple|minor|tiny|trivial|straightforward|boilerplate|scaffold\w*)\b/i, weight: -0.1 },
];

/** A question with no request to change anything: answering it reads, it does not build. */
const QUESTION = /^\s*(what|how|why|which|where|when|who|explain|describe|show me|list|tell me|is there|does|do|can you (tell|explain|show))\b/i;
const CHANGE_VERBS = /\b(add|fix|create|implement|change|update|write|refactor|remove|delete|rename|build|make|migrate|optimi[sz]e|redesign|replace|install|set up|generate)\b/i;

/** A stack trace or traceback: someone is debugging, which is investigation work. */
const STACK = /(^\s+at .+\(.+:\d+(:\d+)?\)|Traceback \(most recent call last\)|^\s+File ".+", line \d+)/m;

export function extractFeatures(input: { text: string; files?: string[]; criteria?: number; step?: boolean }): Features {
  const text = input.text;
  const words = (text.match(/\S+/g) ?? []).length;
  const mentioned = new Set([...(input.files ?? []), ...(text.match(/(?:^|\s)@[^\s@]+/g) ?? []).map((m) => m.trim())]);
  // "add X and Y, then Z" and numbered lists are several pieces of work in one request
  const parts = 1 + (text.match(/(\band\b|\bthen\b|\balso\b|;|\n\s*(\d+[.)]|[-*])\s)/gi) ?? []).length;

  const hard = HARD.filter((r) => r.re.test(text)).map((r) => ({ label: r.label, weight: r.weight }));
  if (STACK.test(text)) hard.push({ label: 'stack trace', weight: 0.14 });
  const easy = EASY.filter((r) => r.re.test(text)).map((r) => ({ label: r.label, weight: r.weight }));
  const questionOnly = QUESTION.test(text) && !CHANGE_VERBS.test(text);
  if (questionOnly) easy.push({ label: 'question only', weight: -0.12 });
  // "the difference between let and const" is one question, not two pieces of work
  return { step: Boolean(input.step), words, files: mentioned.size, criteria: input.criteria ?? 0, parts: questionOnly ? 1 : parts, hard, easy };
}

export interface LocalScore {
  score: number;
  /** Every contribution, for the explanation shown to the user. */
  contributions: Signal[];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const BASE = 0.3;

/** 0 (routine) .. 1 (needs the strongest model thinking hard). Several hard signals count with diminishing weight. */
export function localScore(f: Features): LocalScore {
  const contributions: Signal[] = [];
  // Hardest signal counts in full, the next at 70%, then 49%...: three matching keywords is not three times as hard.
  [...f.hard].sort((a, b) => b.weight - a.weight).forEach((s, i) => contributions.push({ label: s.label, weight: s.weight * 0.7 ** i }));
  [...f.easy].sort((a, b) => a.weight - b.weight).forEach((s, i) => contributions.push({ label: s.label, weight: s.weight * 0.7 ** i }));
  if (!f.step) {
    if (f.words > 120) contributions.push({ label: `long request (${f.words} words)`, weight: 0.1 });
    else if (f.words > 60) contributions.push({ label: `detailed request (${f.words} words)`, weight: 0.05 });
    else if (f.words < 8) contributions.push({ label: 'very short request', weight: -0.05 });
  }
  if (f.files >= 6) contributions.push({ label: `${f.files} files`, weight: 0.12 });
  else if (f.files >= 3) contributions.push({ label: `${f.files} files`, weight: 0.06 });
  if (!f.step) {
    if (f.parts >= 4) contributions.push({ label: `${f.parts} parts`, weight: 0.1 });
    else if (f.parts >= 2) contributions.push({ label: `${f.parts} parts`, weight: 0.04 });
  }
  if (f.criteria >= 3) contributions.push({ label: `${f.criteria} acceptance criteria`, weight: 0.04 });
  const score = clamp01(BASE + contributions.reduce((n, c) => n + c.weight, 0));
  return { score, contributions };
}
