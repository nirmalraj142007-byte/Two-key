import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, runSeed, testDatabaseUrl } from '../src/testing.js';

/**
 * scripts/db-roles.sql applied to a throwaway database. Roles are cluster-wide, so the test
 * renames them with a random suffix and drops them afterwards: the real role names are never
 * created by tests, and no other database is touched.
 */
const baseUrl = testDatabaseUrl();
const SQL = readFileSync(new URL('../../../scripts/db-roles.sql', import.meta.url), 'utf8');
const sfx = randomBytes(3).toString('hex');
const role = (name: 'gateway' | 'web' | 'runner') => `twokey_${name}_${sfx}`;
const script = SQL.replace(/\btwokey_(gateway|web|runner|jobs)\b/g, `$&_${sfx}`);
const PASSWORD = randomBytes(12).toString('hex');

type Sql = ReturnType<typeof postgres>;
const DENIED = '42501'; // insufficient_privilege, also raised for row-level-security violations

async function denied(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({ code: DENIED });
}

describe.skipIf(!baseUrl)('scripts/db-roles.sql', () => {
  let url = '';
  let drop = async () => {};
  let owner: Sql;
  const as: Record<'gateway' | 'web' | 'runner', Sql> = {} as never;
  const urlAs = (r: string) => {
    const u = new URL(url);
    u.username = r;
    u.password = PASSWORD;
    return u.toString();
  };
  const ids = { user: '', draft: '', signed: '', session: '', proposal: '', payment: '' };

  beforeAll(async () => {
    ({ url, drop } = await createTestDatabase(baseUrl as string));
    await runSeed(url);
    // pg-boss is installed by the owner first (as the gateway's first start does), with one queue.
    const boss = new PgBoss({ connectionString: url, supervise: false, schedule: false });
    await boss.start();
    await boss.createQueue('roles.test');
    await boss.stop({ graceful: false });

    owner = postgres(url, { max: 1, onnotice: () => {} });
    await owner.unsafe(script);
    await owner.unsafe(script); // idempotent
    for (const r of ['gateway', 'web', 'runner'] as const) {
      await owner.unsafe(`alter role ${role(r)} password '${PASSWORD}'`);
      as[r] = postgres(urlAs(role(r)), { max: 1, onnotice: () => {} });
    }

    const [user] = await owner`insert into users (id, email, display_name)
      values (gen_random_uuid(), ${`roles-${sfx}@test.local`}, 'Roles') returning id`;
    ids.user = user?.id;
    const [draft] =
      await owner`insert into rule_cards (id, user_id, version, status, nl_request, rules, enforcement)
      values (gen_random_uuid(), ${ids.user}, 1, 'draft', 'x', '{}', '{}') returning id`;
    ids.draft = draft?.id;
    const [signed] =
      await owner`insert into rule_cards (id, user_id, version, status, nl_request, rules, enforcement, signed_at, hmac, key_id)
      values (gen_random_uuid(), ${ids.user}, 2, 'signed', 'x', '{}', '{}', now(), 'mac', 'k') returning id`;
    ids.signed = signed?.id;
    const [session] =
      await owner`insert into agent_sessions (id, user_id, rule_card_id, mode, model, agent_token_hash)
      values (gen_random_uuid(), ${ids.user}, ${ids.signed}, 'demo', 'm', ${`hash-${sfx}`}) returning id`;
    ids.session = session?.id;
    const [listing] = await owner`select id, merchant_id from listings limit 1`;
    const [proposal] =
      await owner`insert into proposals (id, session_id, rule_card_id, listing_id, qty, raw_tool_args, resolved_amount_cents, resolved_merchant_id)
      values (gen_random_uuid(), ${ids.session}, ${ids.signed}, ${listing?.id}, 1, '{}', 5400, ${listing?.merchant_id}) returning id`;
    ids.proposal = proposal?.id;
    const [payment] =
      await owner`insert into payments (id, proposal_id, payee_merchant_id, amount_cents, state)
      values (gen_random_uuid(), ${ids.proposal}, ${listing?.merchant_id}, 5400, 'held') returning id`;
    ids.payment = payment?.id;
  }, 120_000);

  afterAll(async () => {
    await Promise.all([owner, ...Object.values(as)].map((c) => c?.end()));
    await drop();
    if (!baseUrl) return;
    const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
    try {
      for (const r of ['twokey_gateway', 'twokey_web', 'twokey_runner', 'twokey_jobs']) {
        await admin.unsafe(`drop role if exists ${r}_${sfx}`);
      }
    } finally {
      await admin.end();
    }
  });

  it('web reads everything but never writes payments, approvals or gate decisions', async () => {
    const { web } = as;
    expect(await web`select count(*)::int as n from payments`).toEqual([{ n: 1 }]);
    await denied(() => web`update payments set state = 'captured' where id = ${ids.payment}`);
    await denied(
      () => web`insert into approvals (payment_id, user_id, status, reason, deadline_at)
      values (${ids.payment}, ${ids.user}, 'approved', '{}', now())`,
    );
    await denied(() => web`update approvals set status = 'approved'`);
    await denied(
      () => web`insert into gate_decisions (proposal_id, gate, outcome, rule_hits, gate_version)
      values (${ids.proposal}, 'G4', 'capture', '[]', 'x')`,
    );
    await denied(() => web`delete from payments`);
    await denied(() => web`update vault_tokens set status = 'active'`);
    await denied(() => web`create table web_owned (id int)`);
  });

  it('web writes only draft rule cards, and can never sign one', async () => {
    const { web } = as;
    const inserted =
      await web`insert into rule_cards (id, user_id, version, status, nl_request, rules, enforcement)
      values (gen_random_uuid(), ${ids.user}, 3, 'draft', 'y', '{}', '{}') returning id`;
    expect(inserted).toHaveLength(1);
    await denied(
      () => web`insert into rule_cards (user_id, version, status, nl_request, rules, enforcement, signed_at, hmac, key_id)
      values (${ids.user}, 4, 'signed', 'y', '{}', '{}', now(), 'forged', 'k')`,
    );
    await denied(
      () => web`update rule_cards set status = 'signed', hmac = 'forged', signed_at = now()
      where id = ${ids.draft}`,
    );
    // A signed card is invisible to web's UPDATE policy: nothing changes.
    const touched =
      await web`update rule_cards set nl_request = 'changed' where id = ${ids.signed}`;
    expect(touched.count).toBe(0);
  });

  it('web ends sessions and logs hijack attempts, but cannot touch transcripts', async () => {
    const { web } = as;
    await web`update agent_sessions set status = 'ended', ended_at = now() where id = ${ids.session}`;
    await denied(() => web`update agent_sessions set transcript = '[]' where id = ${ids.session}`);
    await denied(() => web`update agent_sessions set rule_card_id = ${ids.draft}`);
    await owner`update agent_sessions set status = 'active', ended_at = null where id = ${ids.session}`;
  });

  it('the runner writes transcripts, reasoning excerpts and its budget, nothing about money', async () => {
    const { runner } = as;
    await runner`update agent_sessions set transcript = '[{"role":"user"}]', status = 'ended', ended_at = now()
      where id = ${ids.session}`;
    await runner`update proposals set agent_reasoning_excerpt = 'because' where id = ${ids.proposal}`;
    await runner`insert into budget_ledger (day, scope, spent_usd, cap_usd)
      values (current_date, 'eval', 0, 1) on conflict do nothing`;
    await denied(() => runner`update proposals set qty = 9 where id = ${ids.proposal}`);
    await denied(() => runner`update proposals set resolved_amount_cents = 1`);
    await denied(() => runner`update agent_sessions set rule_card_id = ${ids.draft}`);
    await denied(() => runner`update payments set state = 'captured'`);
    await denied(
      () => runner`insert into gate_decisions (proposal_id, gate, outcome, rule_hits, gate_version)
      values (${ids.proposal}, 'G0', 'capture', '[]', 'x')`,
    );
    await denied(() => runner`update approvals set status = 'approved'`);
    await denied(
      () => runner`insert into rule_cards (user_id, version, status, nl_request, rules, enforcement)
      values (${ids.user}, 9, 'draft', 'z', '{}', '{}')`,
    );
  });

  it('the gateway has full DML but no DDL', async () => {
    const { gateway } = as;
    await gateway`update payments set state = 'void_requested' where id = ${ids.payment}`;
    await gateway`update rule_cards set status = 'revoked' where id = ${ids.signed}`;
    await denied(() => gateway`drop table payments`);
    await denied(() => gateway`create table gateway_owned (id int)`);
    await denied(() => gateway`alter table payments add column x int`);
  });

  it('every service can use pg-boss; web cannot drop or alter it', async () => {
    for (const r of ['gateway', 'web', 'runner'] as const) {
      const boss = new PgBoss({
        connectionString: urlAs(role(r)),
        supervise: false,
        schedule: false,
      });
      await boss.start();
      const id = await boss.send('roles.test', { from: r });
      expect(id).toBeTruthy();
      await boss.stop({ graceful: false });
    }
    // Web only sends jobs: it can't drop or alter the job schema.
    await denied(() => as.web`drop schema pgboss cascade`);
    await denied(() => as.web`drop table pgboss.queue`);
  });
});
