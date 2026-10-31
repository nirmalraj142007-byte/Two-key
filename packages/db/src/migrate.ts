import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // With least-privilege roles (scripts/db-roles.sql) the service role cannot run DDL, so
  // migrations use the owner URL when MIGRATE_DATABASE_URL is set (docs/DEPLOY.md).
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }
  await runMigrations(url);
  process.stdout.write('migrations applied\n');
}
