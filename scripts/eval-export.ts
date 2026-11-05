/**
 * npm run eval:export -- --target <DATABASE_URL> [--dry-run]
 * EXPORT_TARGET_DATABASE_URL=<url> npm run eval:export [-- --dry-run]   (keeps the password out
 *   of npm's echoed command line)
 *
 * Copies the evaluation results the public explorer reads from the local database (DATABASE_URL,
 * .env.eval) to another database (the production Neon one), in one transaction, idempotently.
 *
 * Copied: eval_tasks, attack_templates, eval_episodes, eval_episode_listings, eval_runs,
 * predictions; the eval-mode agent_sessions that eval_runs point at, their proposals and
 * gate_decisions; and what those rows reference: the eval_frozen catalog snapshot, its listings,
 * their merchants, the evaluation's signed rule cards and its system user (eval@twokey.system).
 *
 * Never copied: hijack attempts, live/demo/hijack sessions, payments, approvals, webhooks,
 * vault tokens, push subscriptions, budgets, or any other user.
 *
 * Rows already on the target are updated by primary key, so rerunning is safe. Merchants and the
 * evaluation user are matched by slug and email and are never changed on the target (their
 * PayPal fields belong to production); local IDs are remapped to the target's. The copy refuses
 * to run if the two databases have different migrations, if the target holds evaluation rows the
 * local database doesn't, or if any row would reference something outside the evaluation.
 *
 * --dry-run does everything inside the target transaction, prints the counts, then rolls back.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';

type Row = Record<string, unknown>;
type Sql = postgres.Sql | postgres.TransactionSql;

export const EVAL_USER_EMAIL = 'eval@twokey.system';

/** Insert order (parents first). */
const TABLES = [
  'merchants',
  'users',
  'catalog_snapshots',
  'listings',
  'eval_tasks',
  'attack_templates',
  'eval_episodes',
  'eval_episode_listings',
  'rule_cards',
  'agent_sessions',
  'proposals',
  'gate_decisions',
  'eval_runs',
  'predictions',
] as const;
type Table = (typeof TABLES)[number];

/** Evaluation-only tables: the target must not hold rows the source doesn't. */
const EVAL_ONLY: Table[] = ['eval_tasks', 'eval_episodes', 'eval_runs', 'predictions'];

export interface TableCount {
  table: Table;
  source: number;
  inserted: number;
  updated: number;
  matched: number;
}

export interface ExportResult {
  dryRun: boolean;
  counts: TableCount[];
}

/** Rows per insert statement: each statement is one round trip to the target. */
const CHUNK = 500;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function sameDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  const host = (u: URL) =>
    u.hostname === '127.0.0.1' || u.hostname === '::1' ? 'localhost' : u.hostname;
  return (
    host(ua) === host(ub) &&
    (ua.port || '5432') === (ub.port || '5432') &&
    ua.pathname === ub.pathname
  );
}

async function rowsOf(sql: Sql, query: string): Promise<Row[]> {
  const result = await sql.unsafe<{ r: Row }[]>(`select to_jsonb(t) as r from (${query}) t`);
  return result.map((x) => x.r);
}

/** Reads every row to copy, in one repeatable-read snapshot of the source. */
async function readSource(src: postgres.Sql): Promise<Record<Table, Row[]>> {
  return (await src.begin('isolation level repeatable read read only', async (tx) => {
    const sessions = `select id from agent_sessions where mode = 'eval'
                      and id in (select session_id from eval_runs where session_id is not null)`;
    const props = `select id from proposals where session_id in (${sessions})`;
    const cards = `select rule_card_id from agent_sessions where id in (${sessions})
                   union select rule_card_id from proposals where id in (${props})`;
    const listingIds = `select listing_id from eval_episode_listings
                        union select target_listing_id from eval_episodes where target_listing_id is not null
                        union select injected_listing_id from eval_episodes where injected_listing_id is not null
                        union select listing_id from proposals where id in (${props})`;

    const data = {} as Record<Table, Row[]>;
    data.eval_runs = await rowsOf(tx, 'select * from eval_runs');
    const orphans = await tx.unsafe<{ n: number }[]>(
      `select count(*)::int as n from eval_runs where session_id is not null
       and session_id not in (${sessions})`,
    );
    if ((orphans[0]?.n ?? 0) > 0) {
      throw new Error(`${orphans[0]?.n} eval_runs point at a session that is not mode 'eval'`);
    }
    data.agent_sessions = await rowsOf(
      tx,
      `select * from agent_sessions where id in (${sessions})`,
    );
    data.proposals = await rowsOf(tx, `select * from proposals where id in (${props})`);
    data.gate_decisions = await rowsOf(
      tx,
      `select * from gate_decisions where proposal_id in (${props})`,
    );
    data.rule_cards = await rowsOf(tx, `select * from rule_cards where id in (${cards})`);
    data.users = await rowsOf(
      tx,
      `select * from users where id in (select user_id from rule_cards where id in (${cards})
                                        union select user_id from agent_sessions where id in (${sessions}))`,
    );
    data.eval_tasks = await rowsOf(tx, 'select * from eval_tasks');
    data.attack_templates = await rowsOf(tx, 'select * from attack_templates');
    data.eval_episodes = await rowsOf(tx, 'select * from eval_episodes');
    data.eval_episode_listings = await rowsOf(tx, 'select * from eval_episode_listings');
    data.predictions = await rowsOf(tx, 'select * from predictions');
    data.listings = await rowsOf(tx, `select * from listings where id in (${listingIds})`);
    data.catalog_snapshots = await rowsOf(
      tx,
      `select * from catalog_snapshots where id in (select snapshot_id from listings where id in (${listingIds}))`,
    );
    data.merchants = await rowsOf(
      tx,
      `select * from merchants where id in (select merchant_id from listings where id in (${listingIds})
                                            union select resolved_merchant_id from proposals where id in (${props}))`,
    );
    return data;
  })) as Record<Table, Row[]>;
}

/** Fails closed on anything that is not evaluation data. */
function assertEvalOnly(data: Record<Table, Row[]>): void {
  for (const u of data.users) {
    if (u.email !== EVAL_USER_EMAIL || u.password_hash !== null) {
      throw new Error(
        'an evaluation session or rule card belongs to a user other than eval@twokey.system',
      );
    }
  }
  for (const s of data.catalog_snapshots) {
    if (s.kind !== 'eval_frozen') {
      throw new Error(`a copied listing is in a ${String(s.kind)} snapshot, not eval_frozen`);
    }
  }
  for (const s of data.agent_sessions) {
    if (s.mode !== 'eval') throw new Error('a copied session is not mode eval');
  }
}

async function migrationHashes(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe<{ hash: string }[]>(
    'select hash from drizzle.__drizzle_migrations order by created_at, id',
  );
  return rows.map((r) => r.hash);
}

type Columns = { cols: string[]; pk: string[] };
/** Per export: each table's columns are looked up once, not once per insert. */
type ColumnCache = Map<Table, Columns>;
/** Called after each statement with the table, rows written so far and the table's total. */
export type Progress = (table: Table, done: number, total: number) => void;

async function columnsOf(sql: Sql, table: Table, cache?: ColumnCache): Promise<Columns> {
  const hit = cache?.get(table);
  if (hit) return hit;
  const found = await readColumns(sql, table);
  cache?.set(table, found);
  return found;
}

async function readColumns(sql: Sql, table: Table): Promise<Columns> {
  const cols = await sql.unsafe<{ c: string }[]>(
    `select column_name as c from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table],
  );
  const pk = await sql.unsafe<{ c: string }[]>(
    `select a.attname as c from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary order by a.attnum`,
    [`public.${table}`],
  );
  return { cols: cols.map((r) => r.c), pk: pk.map((r) => r.c) };
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Upserts rows by primary key; returns how many were inserted and updated. */
async function upsert(
  tx: Sql,
  table: Table,
  rows: Row[],
  cache?: ColumnCache,
  progress?: Progress,
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const { cols, pk } = await columnsOf(tx, table, cache);
  const rest = cols.filter((c) => !pk.includes(c));
  const list = cols.map(ident).join(', ');
  const onConflict =
    rest.length === 0
      ? 'do nothing'
      : `do update set ${rest.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`;
  let inserted = 0;
  let updated = 0;
  for (const part of chunks(rows)) {
    const result = await tx.unsafe<{ inserted: boolean }[]>(
      `insert into ${ident(table)} (${list})
       select ${list} from jsonb_populate_recordset(null::${ident(table)}, $1::text::jsonb)
       on conflict (${pk.map(ident).join(', ')}) ${onConflict}
       returning (xmax = 0) as inserted`,
      [JSON.stringify(part)],
    );
    for (const r of result) r.inserted ? inserted++ : updated++;
    progress?.(table, inserted + updated, rows.length);
  }
  return { inserted, updated };
}

async function targetOnlyIds(tx: Sql, table: Table, ids: string[]): Promise<number> {
  const rows = await tx.unsafe<{ n: number }[]>(
    `select count(*)::int as n from ${ident(table)} where not (id = any($1::uuid[]))`,
    [ids],
  );
  return rows[0]?.n ?? 0;
}

export async function exportEval(opts: {
  source: string;
  target: string;
  dryRun: boolean;
  /** Called once the source is read, with each table's row count, before anything is written. */
  onPlan?: (rows: Record<Table, number>) => void;
  progress?: Progress;
}): Promise<ExportResult> {
  const cache: ColumnCache = new Map();
  if (sameDatabase(opts.source, opts.target)) {
    throw new Error('target is the source database');
  }
  const src = postgres(opts.source, { max: 1, onnotice: () => {} });
  const tgt = postgres(opts.target, { max: 1, onnotice: () => {} });
  try {
    const [srcMig, tgtMig] = await Promise.all([migrationHashes(src), migrationHashes(tgt)]);
    if (srcMig.join() !== tgtMig.join()) {
      throw new Error(
        `migrations differ (local ${srcMig.length}, target ${tgtMig.length}); deploy the same release first`,
      );
    }

    const data = await readSource(src);
    assertEvalOnly(data);
    opts.onPlan?.(
      Object.fromEntries(TABLES.map((t) => [t, data[t].length])) as Record<Table, number>,
    );

    const counts: TableCount[] = [];
    const rollback = new Error('dry run');
    try {
      await tgt.begin(async (tx) => {
        for (const table of EVAL_ONLY) {
          const n = await targetOnlyIds(
            tx,
            table,
            data[table].map((r) => String(r.id)),
          );
          if (n > 0) {
            throw new Error(`target has ${n} ${table} rows the local database doesn't; refusing`);
          }
        }

        // Merchants: matched by slug, inserted only when missing, never changed.
        // One lookup for every slug, then the missing ones in batches (not a round trip each).
        const merchantId = new Map<string, string>();
        const existing = await tx.unsafe<{ id: string; slug: string }[]>(
          'select id, slug from merchants where slug = any($1::text[])',
          [data.merchants.map((m) => String(m.slug))],
        );
        const bySlug = new Map(existing.map((e) => [e.slug, e.id]));
        const missing: Row[] = [];
        for (const m of data.merchants) {
          const found = bySlug.get(String(m.slug));
          if (found) {
            merchantId.set(String(m.id), found);
          } else {
            missing.push(m);
            merchantId.set(String(m.id), String(m.id));
          }
        }
        await upsert(tx, 'merchants', missing, cache, opts.progress);
        const mInserted = missing.length;
        counts.push({
          table: 'merchants',
          source: data.merchants.length,
          inserted: mInserted,
          updated: 0,
          matched: data.merchants.length - mInserted,
        });

        // The evaluation's system user: matched by email, inserted only when missing.
        const userId = new Map<string, string>();
        let uInserted = 0;
        for (const u of data.users) {
          const [found] = await tx.unsafe<{ id: string; role: string }[]>(
            'select id, role from users where email = $1',
            [EVAL_USER_EMAIL],
          );
          if (found && found.role !== 'hijack_system') {
            throw new Error(`${EVAL_USER_EMAIL} on the target is not a system user`);
          }
          if (found) {
            userId.set(String(u.id), found.id);
          } else {
            await upsert(tx, 'users', [u], cache);
            userId.set(String(u.id), String(u.id));
            uInserted++;
          }
        }
        counts.push({
          table: 'users',
          source: data.users.length,
          inserted: uInserted,
          updated: 0,
          matched: data.users.length - uInserted,
        });

        const remap = (map: Map<string, string>, v: unknown) => map.get(String(v)) ?? v;
        for (const l of data.listings) l.merchant_id = remap(merchantId, l.merchant_id);
        for (const p of data.proposals) {
          p.resolved_merchant_id = remap(merchantId, p.resolved_merchant_id);
        }
        for (const c of data.rule_cards) c.user_id = remap(userId, c.user_id);
        for (const s of data.agent_sessions) {
          s.user_id = remap(userId, s.user_id);
          // Agent tokens are never copied; the explorer doesn't read them.
          s.agent_token_hash = `exported:${String(s.id)}`;
        }

        // Each copied episode's listing set is replaced as a whole.
        const episodeIds = data.eval_episodes.map((e) => String(e.id));
        await tx.unsafe('delete from eval_episode_listings where episode_id = any($1::uuid[])', [
          episodeIds,
        ]);

        for (const table of TABLES) {
          if (table === 'merchants' || table === 'users') continue;
          const r = await upsert(tx, table, data[table], cache, opts.progress);
          counts.push({ table, source: data[table].length, ...r, matched: 0 });
        }
        if (opts.dryRun) throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
    return { dryRun: opts.dryRun, counts };
  } finally {
    await Promise.all([src.end(), tgt.end()]);
  }
}

function redact(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const source = values.source ?? process.env.DATABASE_URL;
  // npm echoes its command line, so a URL with a password is better passed in the environment.
  const target = values.target ?? process.env.EXPORT_TARGET_DATABASE_URL;
  if (!target || !source) {
    console.error(
      'usage: npm run eval:export -- --target <DATABASE_URL> [--dry-run]\n' +
        '   or: EXPORT_TARGET_DATABASE_URL=<url> npm run eval:export [-- --dry-run]',
    );
    process.exit(2);
  }
  const dryRun = values['dry-run'] ?? false;
  console.log(`eval export ${redact(source)} -> ${redact(target)}${dryRun ? ' (dry run)' : ''}`);
  const started = Date.now();
  const secs = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const { counts } = await exportEval({
    source,
    target,
    dryRun,
    onPlan: (rows) => {
      console.log('source rows to copy (merchants and users are matched first, then inserted):');
      for (const [t, n] of Object.entries(rows)) console.log(`  ${t.padEnd(22)} ${n}`);
    },
    progress: (table, done, total) => console.log(`  [${secs()}] ${table} ${done}/${total}`),
  });
  console.log('table                   source  inserted  updated  matched');
  for (const c of counts) {
    console.log(
      `${c.table.padEnd(22)} ${String(c.source).padStart(7)} ${String(c.inserted).padStart(9)} ${String(c.updated).padStart(8)} ${String(c.matched).padStart(8)}`,
    );
  }
  console.log(dryRun ? 'DRY RUN: rolled back, nothing written' : 'COMMITTED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`eval export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
