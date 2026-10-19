import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

export { runSeed } from '../seed/seed.js';

/**
 * DATABASE_URL for database tests. Locally a missing URL skips them; in CI (process.env.CI set)
 * it throws, so the test file fails instead of silently skipping.
 */
export function testDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.CI) {
    throw new Error('DATABASE_URL is required in CI: database tests must not skip');
  }
  process.stderr.write('database tests skipped: DATABASE_URL is not set\n');
  return undefined;
}

export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Creates a throwaway, fully migrated database next to `baseUrl`. */
export async function createTestDatabase(
  baseUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `twokey_test_${randomBytes(4).toString('hex')}`;
  const admin = () => postgres(withDatabase(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
  const create = admin();
  try {
    await create.unsafe(`create database ${name}`);
  } finally {
    await create.end();
  }
  const url = withDatabase(baseUrl, name);
  await runMigrations(url);
  return {
    url,
    async drop() {
      const drop = admin();
      try {
        await drop.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await drop.end();
      }
    },
  };
}
