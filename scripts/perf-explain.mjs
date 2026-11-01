/**
 * EXPLAIN (ANALYZE, BUFFERS) for the hot read queries (phase 29), on the local database. Prints
 * each query's execution time and any sequential scans; read-only.
 *
 *   node scripts/perf-explain.mjs
 *
 * The SQL mirrors the Drizzle queries in apps/web/app/api/history/route.ts,
 * eval/src/metrics.ts (loadMetricsRows, used by the results summary and the episodes route),
 * apps/web/lib/episodes-queries.ts and apps/gateway/src/routes/agent.ts (demo catalog search).
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import postgres from 'postgres';

const url = parseEnv(
  readFileSync(new URL('../.env.gateway', import.meta.url), 'utf8'),
).DATABASE_URL;
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('local DB only');
const sql = postgres(url, { max: 1 });
const [busiest] =
  await sql`select s.user_id from proposals p join agent_sessions s on s.id = p.session_id where s.mode <> 'eval' group by 1 order by count(*) desc limit 1`;
const userId = busiest?.user_id ?? '00000000-0000-0000-0000-000000000000';

const queries = {
  'history route (busiest user, limit 500)': `select p.id, l.title, m.display_name, gd.outcome, gd.rule_hits, pay.id, pay.state from proposals p join agent_sessions s on s.id = p.session_id join listings l on l.id = p.listing_id join merchants m on m.id = p.resolved_merchant_id left join gate_decisions gd on gd.proposal_id = p.id and gd.gate = 'G4' left join payments pay on pay.proposal_id = p.id where s.user_id = '${userId}' and s.mode <> 'eval' order by p.created_at desc limit 500`,
  'results summary: runs of a split': `select r.episode_id, r.model, e.variant, e.target_type, e.target_listing_id, r.session_id, r.followed_attack, r.tokens_in, r.tokens_out, r.cost_usd from eval_runs r join eval_episodes e on e.id = r.episode_id join eval_tasks t on t.id = e.task_id where t.split = 'dev'`,
  'results summary: proposals and gate decisions (500 sessions)': `select p.id, p.session_id, p.listing_id, p.resolved_amount_cents, m.role, gd.gate, gd.outcome, gd.rule_hits from proposals p join agent_sessions s on s.id = p.session_id join merchants m on m.id = p.resolved_merchant_id left join gate_decisions gd on gd.proposal_id = p.id where p.session_id in (select r.session_id from eval_runs r join eval_episodes e on e.id = r.episode_id join eval_tasks t on t.id = e.task_id where t.split = 'dev' and r.session_id is not null limit 500) order by p.created_at, p.id`,
  'results summary: test-run count': `select count(*) from eval_runs r join eval_episodes e on e.id = r.episode_id join eval_tasks t on t.id = e.task_id where t.split = 'test'`,
  'episodes route: episodes of a split': `select e.id, e.task_id, e.target_fallback from eval_episodes e join eval_tasks t on t.id = e.task_id where t.split = 'dev'`,
  'episodes route: run ids by session (500)': `select id, session_id from eval_runs where session_id in (select session_id from eval_runs limit 500)`,
  'episodes route: listing titles (500)': `select l.id, l.title from listings l where l.id = any(select listing_id from proposals limit 500)`,
  'demo catalog search (ILIKE, 2 words)': `select l.id, l.title, m.display_name, l.price_cents, l.category from listings l join catalog_snapshots cs on cs.id = l.snapshot_id join merchants m on m.id = l.merchant_id where cs.kind = 'demo_unbranded' and (l.title ilike '%shoe%' or l.category ilike '%shoe%' or l.title ilike '%running%' or l.category ilike '%running%') order by (case when l.title ilike '%shoe%' or l.category ilike '%shoe%' then 1 else 0 end + case when l.title ilike '%running%' or l.category ilike '%running%' then 1 else 0 end) desc, l.price_cents, l.title limit 6`,
  'blocked path: category median': `select round(percentile_cont(0.5) within group (order by price_cents))::int from listings where snapshot_id = (select snapshot_id from listings limit 1) and category = (select category from listings limit 1)`,
};

for (const [name, query] of Object.entries(queries)) {
  const plan = (await sql.unsafe(`explain (analyze, buffers) ${query}`)).map(
    (r) => r['QUERY PLAN'],
  );
  const time = plan.find((l) => l.startsWith('Execution Time'))?.replace('Execution Time: ', '');
  const scans = plan.filter((l) => l.includes('Seq Scan')).length;
  console.log(`${name.padEnd(62)} ${time?.padStart(11)}   seq scans: ${scans}`);
}
await sql.end();
