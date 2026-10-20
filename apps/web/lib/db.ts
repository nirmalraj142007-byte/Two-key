import { createDb, type Db } from '@twokey/db';
import { webEnv } from './env';

// One pool per server process; dev reloads reuse it through globalThis.
const g = globalThis as { twokeyDb?: Db };

export function db(): Db {
  g.twokeyDb ??= createDb(webEnv().DATABASE_URL).db;
  return g.twokeyDb;
}
