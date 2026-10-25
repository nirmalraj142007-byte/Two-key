import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/** Neon wakes from scale-to-zero slowly, and Render adds a cross-region hop. */
export const CONNECT_TIMEOUT_MS = 15_000;

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, connect_timeout: CONNECT_TIMEOUT_MS / 1000 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Db = ReturnType<typeof createDb>['db'];

/** Connection options for pg-boss (which uses `pg`), shared by the gateway and the agent runner. */
export function pgBossConnection(url: string, applicationName: string) {
  return {
    connectionString: url,
    application_name: applicationName,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

/**
 * Runs `start`, retrying twice (3 s, then 6 s) so one slow database wake-up does not kill the
 * service. `cleanup` runs after each failed attempt.
 */
export async function startWithRetry<T>(
  start: () => Promise<T>,
  cleanup: () => Promise<unknown>,
  onRetry: (err: unknown, attempt: number) => void = () => {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (err) {
      await cleanup().catch(() => undefined);
      if (attempt >= 3) throw err;
      onRetry(err, attempt);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}
