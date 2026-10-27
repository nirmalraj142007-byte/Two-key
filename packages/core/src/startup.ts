import type { ServiceName } from './env.js';
import { AppError } from './errors.js';

function keyList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

/**
 * One stderr line (plus a stack for unexpected errors) describing why a service died.
 * For config errors it names the missing/invalid keys, never their values.
 */
export function formatFatal(service: ServiceName | string, what: string, err: unknown): string {
  if (err instanceof AppError) {
    const missing = keyList(err.details?.missing);
    const invalid = keyList(err.details?.invalid);
    // loadEnv's message already names the keys; add them only when it doesn't.
    const keys = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      invalid.length ? `invalid: ${invalid.join(', ')}` : '',
    ].filter((k) => k !== '' && !err.message.includes(k));
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    return `${service}: ${what}: ${err.code} ${err.message}${keys.length ? ` [${keys.join('; ')}]` : ''}${cause}`;
  }
  if (err instanceof Error) {
    return `${service}: ${what}: INTERNAL ${err.stack ?? `${err.name}: ${err.message}`}`;
  }
  return `${service}: ${what}: INTERNAL ${String(err)}`;
}

/** Exits with code 1 once everything already written to stderr has been flushed. */
function exitAfterFlush(): void {
  process.stderr.write('', () => process.exit(1));
}

/**
 * Reports a failed startup synchronously on stderr and sets exit code 1. The process then
 * ends on its own; a backstop exits it if a stray handle would keep it alive.
 */
export function reportStartupFailure(service: ServiceName, err: unknown): void {
  console.error(formatFatal(service, 'startup failed', err));
  process.exitCode = 1;
  setTimeout(exitAfterFlush, 2_000).unref();
}

/** Uncaught errors are reported like startup failures, then the process exits after flushing. */
export function installCrashHandlers(service: ServiceName): void {
  process.on('uncaughtException', (err) => {
    console.error(formatFatal(service, 'uncaughtException', err));
    process.exitCode = 1;
    exitAfterFlush();
  });
  process.on('unhandledRejection', (err) => {
    console.error(formatFatal(service, 'unhandledRejection', err));
    process.exitCode = 1;
    exitAfterFlush();
  });
}

/**
 * Every HTTP service binds all IPv4 interfaces: Render's port scan (and its load balancer)
 * only finds a server listening on 0.0.0.0, never one on localhost.
 */
export const LISTEN_HOST = '0.0.0.0';

/** host and port from server.address(), for the one "listening" log line each service writes. */
export function listeningOn(address: unknown): { host: string; port: number } | null {
  if (address === null || typeof address !== 'object') return null;
  const a = address as { address?: unknown; port?: unknown };
  return typeof a.address === 'string' && typeof a.port === 'number'
    ? { host: a.address, port: a.port }
    : null;
}
