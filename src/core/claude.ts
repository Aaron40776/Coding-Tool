import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authError, cancelled, cliMissing, SmartError } from './errors.js';
import { emptyUsage, type LimitWindow, type Usage } from './types.js';

/** Normalised view of Claude Code's `--output-format stream-json` events. */
export type ClaudeStreamEvent =
  | { kind: 'init'; model: string; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; /** Set for tools that modify a file. */ writtenFile?: string }
  | { kind: 'progress'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { kind: 'limits'; windows: Record<string, LimitWindow>; status?: string }
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
  // Long values are shortened later, after the caller has made paths project-relative.
  return oneLine ? `${name} ${oneLine.length > 400 ? oneLine.slice(0, 397) + '...' : oneLine}` : name;
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
      case 'rate_limit_event': {
        const info = isObj(d.rate_limit_info) ? d.rate_limit_info : null;
        const windows: Record<string, LimitWindow> = {};
        if (info && isObj(info.unifiedWindows)) {
          for (const [name, w] of Object.entries(info.unifiedWindows)) {
            if (isObj(w) && typeof w.utilization === 'number') windows[name] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined };
          }
        }
        return Object.keys(windows).length > 0 ? [{ kind: 'limits', windows, status: typeof info?.status === 'string' ? info.status : undefined }] : [];
      }
      case 'result':
        return [
          {
            kind: 'result',
            result: {
              isError: d.is_error === true || (typeof d.subtype === 'string' && d.subtype !== 'success'),
              subtype: str(d.subtype),
              // Failures such as "No conversation found" arrive in `errors`, not `result`.
              text: str(d.result) || (Array.isArray(d.errors) ? d.errors.filter((x) => typeof x === 'string').join('; ') : ''),
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
  /** Persist and continue a Claude Code conversation. Omit for stateless calls (nothing is saved). */
  session?: { id: string; resume: boolean };
  effort?: string;
  /** Built-in tools to allow. `[]` disables all tools; undefined keeps the default set. */
  tools?: string[];
  permissionMode?: string;
  bare?: boolean;
  /**
   * For tool-less calls: skip user/project settings (hooks, plugins), MCP servers and skills. They cannot matter without
   * tools, but each one slows every `claude` start-up.
   */
  lean?: boolean;
  maxBudgetUsd?: number | null;
  extraArgs?: string[];
  onEvent?: (e: ClaudeStreamEvent) => void;
  /** Injectable for tests. */
  spawnImpl?: typeof nodeSpawn;
  binary?: string;
}

export function buildArgs(o: RunClaudeOptions): string[] {
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose'];
  if (o.session) args.push(o.session.resume ? '--resume' : '--session-id', o.session.id);
  else args.push('--no-session-persistence');
  if (o.effort) args.push('--effort', o.effort);
  if (o.systemPrompt !== undefined) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.tools) args.push('--tools', o.tools.join(','));
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.bare) args.push('--bare');
  if (o.lean) args.push('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '');
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

/** Signs of an authentication problem. Deliberately specific: "No conversation found with session ID: …401…" must not match. */
const AUTH_RE = /(not logged in|please (?:run )?\/?log ?in|\/login|not authenticated|authentication (?:failed|error|required)|invalid (?:x-)?api[ -]key|missing api key|\b401\b|unauthori[sz]ed|oauth token)/i;
export const isAuthFailure = (detail: string): boolean => !/No conversation found/i.test(detail) && AUTH_RE.test(detail);

const KILL_GRACE_MS = 2000;

/** Runs one headless Claude Code call. The prompt goes over stdin (no argv size limits, no stdin wait). */
export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(cancelled());

    const spawnFn = opts.spawnImpl ?? nodeSpawn;
    const command: ClaudeCommand = opts.binary ? { cmd: opts.binary, prefix: [] } : resolveClaudeCommand();
    let child: ChildProcess;
    try {
      child = spawnFn(command.cmd, [...command.prefix, ...buildArgs(opts)], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(toSpawnError(e));
    }

    const parser = new StreamParser();
    const timing = debugTiming(opts);
    let result: ClaudeResult | undefined;
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let hangTimer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hangTimer) clearTimeout(hangTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const handle = (events: ClaudeStreamEvent[]) => {
      for (const ev of events) {
        timing?.mark(ev.kind);
        if (ev.kind === 'result') result = ev.result;
        opts.onEvent?.(ev);
      }
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // If a grandchild still holds our pipes, 'close' may never fire: do not let a cancel hang.
        hangTimer = setTimeout(() => finish(() => reject(cancelled())), 1000);
        hangTimer.unref?.();
      }, KILL_GRACE_MS);
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
      timing?.done(code);
      finish(() => {
        if (opts.signal?.aborted) return reject(cancelled());
        if (result) {
          if (result.isError) {
            const detail = result.text || result.subtype || 'unknown error';
            return reject(isAuthFailure(detail) ? authError(detail) : new SmartError('claude', `Claude Code reported an error: ${detail}`));
          }
          return resolve(result);
        }
        const detail = stderr.trim() || `exit code ${code}`;
        reject(isAuthFailure(detail) ? authError(detail) : new SmartError('claude', `Claude Code failed: ${detail}`));
      });
    });
  });
}

/**
 * `SMART_DEBUG=1` appends one line per `claude` call to ~/.smart/debug.log (or `SMART_DEBUG_FILE`): how long start-up took
 * (spawn until Claude Code reports it is ready), how long until the first text, and the total. It shows whether a slow
 * call is Claude Code's own start-up (plugins, hooks, MCP servers) or the model.
 */
function debugTiming(o: RunClaudeOptions): { mark: (kind: string) => void; done: (code: number | null) => void } | null {
  if (!process.env.SMART_DEBUG) return null;
  const t0 = Date.now();
  const at: Record<string, number> = {};
  return {
    mark: (kind) => {
      at[kind] ??= Date.now() - t0;
    },
    done: (code) => {
      const line = {
        time: new Date().toISOString(), model: o.model, tools: o.tools ? (o.tools.length ? 'some' : 'none') : 'all', lean: Boolean(o.lean), effort: o.effort ?? null,
        session: o.session ? (o.session.resume ? 'resume' : 'new') : 'none', exit: code,
        ms: { startupUntilReady: at.init ?? null, firstText: at.text ?? null, firstTool: at.tool ?? null, result: at.result ?? null, total: Date.now() - t0 },
      };
      try {
        const file = process.env.SMART_DEBUG_FILE || `${os.homedir()}/.smart/debug.log`;
        mkdirSync(file.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true });
        appendFileSync(file, `${JSON.stringify(line)}\n`);
      } catch {
        /* diagnostics must never break a run */
      }
    },
  };
}

function toSpawnError(e: unknown): SmartError {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    ? cliMissing()
    : new SmartError('claude', `Could not start Claude Code: ${(e as Error).message}`);
}

export type RunClaudeFn = (opts: RunClaudeOptions) => Promise<ClaudeResult>;

export interface ClaudeCommand {
  cmd: string;
  /** Arguments that must precede the real ones (e.g. the cli.js path when launching via node). */
  prefix: string[];
}

/**
 * Where to find Claude Code. On Windows `claude` may be `claude.exe` (native installer) or the npm
 * `claude.cmd` shim; .cmd files cannot be spawned without a shell (and shell quoting would mangle our
 * arguments), so for the shim we run its `cli.js` with node directly. `SMART_CLAUDE_BIN` overrides all.
 */
export function resolveClaudeCommand(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): ClaudeCommand {
  if (env.SMART_CLAUDE_BIN) return { cmd: env.SMART_CLAUDE_BIN, prefix: [] };
  if (platform !== 'win32') return { cmd: 'claude', prefix: [] };
  const w = path.win32;
  for (const dir of (env.PATH ?? env.Path ?? '').split(w.delimiter).filter(Boolean)) {
    const exe = w.join(dir, 'claude.exe');
    if (exists(exe)) return { cmd: exe, prefix: [] };
    if (exists(w.join(dir, 'claude.cmd'))) {
      for (const rel of [['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'], ['node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs']]) {
        const cli = w.join(dir, ...rel);
        if (exists(cli)) return { cmd: process.execPath, prefix: [cli] };
      }
    }
  }
  return { cmd: 'claude', prefix: [] };
}
