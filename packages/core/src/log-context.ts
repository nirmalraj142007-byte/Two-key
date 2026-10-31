import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

/** Fields every log line carries once they are known for the current request or job. */
export interface LogContext {
  requestId?: string;
  userIdHash?: string;
  sessionId?: string;
  proposalId?: string;
  paymentId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** sha256 of the user ID, first 12 hex characters: lets logs group by user without the ID. */
export function userIdHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An incoming x-request-id is trusted only when it is a UUID (no log injection, bounded size). */
export function requestIdFrom(header: unknown): string {
  return typeof header === 'string' && UUID.test(header) ? header.toLowerCase() : randomUUID();
}

/** Runs `fn` with its own log context; nested calls start from a copy of the outer one. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/**
 * Runs `fn` inside exactly this context object, so fields added later through
 * `addLogContext` are seen by everything else holding it (Fastify re-enters a request's
 * context after body parsing, which loses async context).
 */
export function enterLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Adds fields to the current context (no-op outside one). Later log lines carry them. */
export function addLogContext(ctx: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, ctx);
}

export function currentLogContext(): LogContext {
  return { ...storage.getStore() };
}
