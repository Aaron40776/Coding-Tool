export type ErrorKind = 'cli_missing' | 'auth' | 'cancelled' | 'parse' | 'claude' | 'config';

export class SmartError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'SmartError';
  }
}

export const cliMissing = () =>
  new SmartError(
    'cli_missing',
    'The `claude` CLI was not found on your PATH.',
    'Install Claude Code (https://docs.claude.com/claude-code) and make sure `claude` runs in your shell.',
  );

export const authError = (detail: string) =>
  new SmartError('auth', `Claude Code is not authenticated: ${detail}`, 'Run `claude` once and log in (or set ANTHROPIC_API_KEY).');

export const cancelled = () => new SmartError('cancelled', 'Cancelled.');

export const isCancelled = (e: unknown): boolean => e instanceof SmartError && e.kind === 'cancelled';
