import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { authError, cancelled, cliMissing, SmartError } from './errors.js';
import { emptyUsage, type Usage } from './types.js';

/** Normalised view of Claude Code's `--output-format stream-json` events. */
export type ClaudeStreamEvent =
  | { kind: 'init'; model: string; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; /** Set for tools that modify a file. */ writtenFile?: string }
  | { kind: 'progress'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { kind: 'result'; result: ClaudeResult };

export interface ClaudeResult {
  isError: boolean;
  subtype: string;
  text: string;
  structured: unknown;
  usage: Usage;
  sessionId: string;
  numTurns: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function summarizeTool(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const target = str(i.file_path) || str(i.path) || str(i.command) || str(i.pattern) || str(i.url) || str(i.description);
  const oneLine = target.replace(/\s+/g, ' ').trim();
  return oneLine ? `${name} ${oneLine.length > 100 ? oneLine.slice(0, 97) + '...' : oneLine}` : name;
}

function resultUsage(d: Json): Usage {
  const usage = emptyUsage();
  usage.costUsd = num(d.total_cost_usd);
  const mu = d.modelUsage;
  if (isObj(mu) && Object.keys(mu).length > 0) {
    for (const m of Object.values(mu)) {
      if (!isObj(m)) continue;
      usage.inputTokens += num(m.inputTokens);
      usage.outputTokens += num(m.outputTokens);
      usage.cacheReadTokens += num(m.cacheReadInputTokens);
      usage.cacheCreationTokens += num(m.cacheCreationInputTokens);
    }
  } else if (isObj(d.usage)) {
    usage.inputTokens = num(d.usage.input_tokens);
    usage.outputTokens = num(d.usage.output_tokens);
    usage.cacheReadTokens = num(d.usage.cache_read_input_tokens);
    usage.cacheCreationTokens = num(d.usage.cache_creation_input_tokens);
  }
  return usage;
}

/**
 * Stateful line parser: feed it raw stdout chunks, get normalised events back.
 * Unknown / bulky event types (partial stream events, rate limits, hooks) are ignored.
 */
export class StreamParser {
  private buffer = '';
  private seenMessages = new Set<string>();
  private totals = { input: 0, output: 0, cacheRead: 0 };

  push(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.flatMap((l) => this.parseLine(l));
  }

  end(): ClaudeStreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    return this.parseLine(rest);
  }

  parseLine(line: string): ClaudeStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let d: unknown;
    try {
      d = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObj(d)) return [];

    switch (d.type) {
      case 'system':
        return d.subtype === 'init' ? [{ kind: 'init', model: str(d.model), sessionId: str(d.session_id) }] : [];
      case 'assistant':
        return this.assistant(d);
      case 'result':
        return [
          {
            kind: 'result',
            result: {
              isError: d.is_error === true || (typeof d.subtype === 'string' && d.subtype !== 'success'),
              subtype: str(d.subtype),
              text: str(d.result),
              structured: d.structured_output,
              usage: resultUsage(d),
              sessionId: str(d.session_id),
              numTurns: num(d.num_turns),
            },
          },
        ];
      default:
        return [];
    }
  }

  private assistant(d: Json): ClaudeStreamEvent[] {
    const msg = d.message;
    if (!isObj(msg)) return [];
    const events: ClaudeStreamEvent[] = [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && str(block.text).trim()) events.push({ kind: 'text', text: str(block.text) });
      // StructuredOutput is an internal tool used for --json-schema; not interesting to show.
      else if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
        const name = str(block.name);
        const input = isObj(block.input) ? block.input : {};
        const writtenFile = WRITE_TOOLS.has(name) ? str(input.file_path) || str(input.notebook_path) || undefined : undefined;
        events.push({ kind: 'tool', name, summary: summarizeTool(name, block.input), writtenFile });
      }
    }
    // Claude Code repeats one message per content block, so count each message id once.
    const id = str(msg.id);
    if (isObj(msg.usage) && id && !this.seenMessages.has(id)) {
      this.seenMessages.add(id);
      this.totals.input += num(msg.usage.input_tokens);
      this.totals.output += num(msg.usage.output_tokens);
      this.totals.cacheRead += num(msg.usage.cache_read_input_tokens);
      events.push({
        kind: 'progress',
        inputTokens: this.totals.input,
        outputTokens: this.totals.output,
        cacheReadTokens: this.totals.cacheRead,
      });
    }
    return events;
  }
}

export interface RunClaudeOptions {
  prompt: string;
  model: string;
  cwd: string;
  signal?: AbortSignal;
  systemPrompt?: string;
  /** Appended to Claude Code's default system prompt (keeps its tool instructions). */
  appendSystemPrompt?: string;
  /** JSON schema (object) for structured output. */
  jsonSchema?: object;
  /** Built-in tools to allow. `[]` disables all tools; undefined keeps the default set. */
  tools?: string[];
  permissionMode?: string;
  bare?: boolean;
  maxBudgetUsd?: number | null;
  extraArgs?: string[];
  onEvent?: (e: ClaudeStreamEvent) => void;
  /** Injectable for tests. */
  spawnImpl?: typeof nodeSpawn;
  binary?: string;
}

export function buildArgs(o: RunClaudeOptions): string[] {
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  if (o.systemPrompt !== undefined) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.tools) args.push('--tools', o.tools.join(','));
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.bare) args.push('--bare');
  if (o.maxBudgetUsd) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

/**
 * `bypassPermissions` is refused by Claude Code when running as root (common in Docker/CI),
 * so degrade to `acceptEdits` and tell the caller why.
 */
export function resolvePermissionMode(mode: string, uid: number | undefined = process.getuid?.()): { mode: string; warning?: string } {
  if (mode === 'bypassPermissions' && uid === 0) {
    return {
      mode: 'acceptEdits',
      warning: 'Running as root: Claude Code refuses bypassPermissions here, so using acceptEdits (file edits allowed, other tools may be denied).',
    };
  }
  return { mode };
}

const AUTH_RE = /(not logged in|log ?in|authenticat|invalid api key|api key|401|unauthorized|oauth)/i;

const KILL_GRACE_MS = 2000;

/** Runs one headless Claude Code call. The prompt goes over stdin (no argv size limits, no stdin wait). */
export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(cancelled());

    const spawnFn = opts.spawnImpl ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(opts.binary ?? 'claude', buildArgs(opts), { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(toSpawnError(e));
    }

    const parser = new StreamParser();
    let result: ClaudeResult | undefined;
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const handle = (events: ClaudeStreamEvent[]) => {
      for (const ev of events) {
        if (ev.kind === 'result') result = ev.result;
        opts.onEvent?.(ev);
      }
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => handle(parser.push(c)));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    // The child may exit before reading stdin; ignore EPIPE.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.prompt);

    child.on('error', (e) => finish(() => reject(toSpawnError(e))));
    child.on('close', (code) => {
      handle(parser.end());
      finish(() => {
        if (opts.signal?.aborted) return reject(cancelled());
        if (result) {
          if (result.isError) {
            const detail = result.text || result.subtype || 'unknown error';
            return reject(AUTH_RE.test(detail) ? authError(detail) : new SmartError('claude', `Claude Code reported an error: ${detail}`));
          }
          return resolve(result);
        }
        const detail = stderr.trim() || `exit code ${code}`;
        reject(AUTH_RE.test(detail) ? authError(detail) : new SmartError('claude', `Claude Code failed: ${detail}`));
      });
    });
  });
}

function toSpawnError(e: unknown): SmartError {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    ? cliMissing()
    : new SmartError('claude', `Could not start Claude Code: ${(e as Error).message}`);
}

export type RunClaudeFn = (opts: RunClaudeOptions) => Promise<ClaudeResult>;
