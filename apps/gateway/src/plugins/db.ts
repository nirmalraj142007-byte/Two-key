import { createDb, type Db } from '@twokey/db';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

/** Decorates `app.db` and closes the connection pool when the app shuts down. */
export const dbPlugin = fp<{ url: string }>(
  async (app, opts) => {
    const { db, sql } = createDb(opts.url);
    app.decorate('db', db);
    app.addHook('onClose', async () => {
      await sql.end({ timeout: 5 });
    });
  },
  { name: 'twokey-db' },
);
