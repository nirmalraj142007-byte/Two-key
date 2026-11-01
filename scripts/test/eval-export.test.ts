import { createTestDatabase, testDatabaseUrl } from '@twokey/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportEval } from '../eval-export.js';

const baseUrl = testDatabaseUrl();

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const M = { gift: id(1), store: id(2), stride: id(3), giftTarget: id(9) };
const U = { evalUser: id(11), maya: id(12) };
const S = { evalSnap: id(21), hijackSnap: id(22) };
const L = { item: id(31), injected: id(32), hijack: id(33) };
const C = { evalCard: id(41), mayaCard: id(42) };
const SESS = { run: id(51), hijack: id(52), unused: id(53) };
const P = { evalProp: id(61), hijackProp: id(62) };

async function seedSource(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      insert into merchants (id, slug, display_name, role) values
        ('${M.gift}', 'giftvault', 'GiftVault', 'attacker'),
        ('${M.store}', 'eval-store-1', 'Store 1', 'eval_merchant'),
        ('${M.stride}', 'stride-supply', 'Stride Supply', 'allowed_demo');
      insert into users (id, email, display_name, role) values
        ('${U.evalUser}', 'eval@twokey.system', 'Evaluation', 'hijack_system'),
        ('${U.maya}', 'maya@twokey.demo', 'Maya', 'judge_demo');
      insert into catalog_snapshots (id, kind, content_sha256, git_tag) values
        ('${S.evalSnap}', 'eval_frozen', 'x', 'eval-build'),
        ('${S.hijackSnap}', 'hijack', 'y', null);
      insert into listings (id, snapshot_id, group_key, merchant_id, title, category, price_cents, description) values
        ('${L.item}', '${S.evalSnap}', 'g1', '${M.store}', 'Item', 'shoes', 5400, 'd'),
        ('${L.injected}', '${S.evalSnap}', 'g2', '${M.gift}', 'Gift card', 'gift', 18900, 'd'),
        ('${L.hijack}', '${S.hijackSnap}', 'g3', '${M.gift}', 'Gift card', 'gift', 18900, 'd');
      insert into eval_tasks (id, split, webshop_instruction_id, instruction_text, price_cap_cents, category, goal_attrs, sample_seed)
        values ('${id(71)}', 'test', 'ws-1', 'buy shoes', 7000, 'shoes', '{}', 's');
      insert into attack_templates (id, source, source_ref, original_text, adapted_text, diff, licence)
        values ('${id(72)}', 'injecagent', 'ref', 'o', 'a', 'd', 'MIT');
      insert into eval_episodes (id, task_id, variant, attack_template_id, target_type, target_listing_id, injected_listing_id, injection_position, content_sha256)
        values ('${id(73)}', '${id(71)}', 'injecagent', '${id(72)}', 'outside_rules', '${L.injected}', '${L.injected}', 1, 'c');
      insert into eval_episode_listings (episode_id, listing_id, position) values
        ('${id(73)}', '${L.item}', 0), ('${id(73)}', '${L.injected}', 1);
      insert into rule_cards (id, user_id, version, status, nl_request, rules, enforcement, hmac) values
        ('${C.evalCard}', '${U.evalUser}', 1, 'signed', 'eval task', '{}', '{}', 'h'),
        ('${C.mayaCard}', '${U.maya}', 1, 'signed', 'shoes', '{}', '{}', 'h');
      insert into agent_sessions (id, user_id, rule_card_id, mode, model, agent_token_hash, eval_episode_id) values
        ('${SESS.run}', '${U.evalUser}', '${C.evalCard}', 'eval', 'm', 'hash-run', '${id(73)}'),
        ('${SESS.hijack}', '${U.maya}', '${C.mayaCard}', 'hijack', 'm', 'hash-hijack', null),
        ('${SESS.unused}', '${U.evalUser}', '${C.evalCard}', 'eval', 'm', 'hash-unused', '${id(73)}');
      insert into proposals (id, session_id, rule_card_id, listing_id, qty, raw_tool_args, resolved_amount_cents, resolved_merchant_id) values
        ('${P.evalProp}', '${SESS.run}', '${C.evalCard}', '${L.injected}', 1, '{}', 18900, '${M.gift}'),
        ('${P.hijackProp}', '${SESS.hijack}', '${C.mayaCard}', '${L.hijack}', 1, '{}', 18900, '${M.gift}');
      insert into gate_decisions (id, proposal_id, gate, outcome, rule_hits, gate_version) values
        ('${id(81)}', '${P.evalProp}', 'G4', 'block', '[]', 'v1'),
        ('${id(82)}', '${P.hijackProp}', 'G4', 'block', '[]', 'v1');
      insert into eval_runs (id, episode_id, model, system_prompt_sha256, temperature, session_id, followed_attack)
        values ('${id(91)}', '${id(73)}', 'm', 'sha', 0, '${SESS.run}', true);
      insert into predictions (id, metric, model, predicted_low, predicted_high, registered_commit)
        values ('${id(92)}', 'attack_success', 'm', 0, 0.015, 'f22eeca');
    `);
  } finally {
    await sql.end();
  }
}

describe.skipIf(!baseUrl)('eval export', () => {
  let source: Awaited<ReturnType<typeof createTestDatabase>>;
  let target: Awaited<ReturnType<typeof createTestDatabase>>;
  let tgt: postgres.Sql;

  beforeAll(async () => {
    source = await createTestDatabase(baseUrl as string);
    target = await createTestDatabase(baseUrl as string);
    await seedSource(source.url);
    tgt = postgres(target.url, { max: 1, onnotice: () => {} });
    // Production already has GiftVault, under its own id and PayPal merchant id.
    await tgt.unsafe(`insert into merchants (id, slug, display_name, role, paypal_merchant_id)
      values ('${M.giftTarget}', 'giftvault', 'GiftVault', 'attacker', 'PROD-GIFT')`);
  }, 120_000);

  afterAll(async () => {
    await tgt?.end();
    await source?.drop();
    await target?.drop();
  });

  const count = async (table: string) =>
    Number((await tgt.unsafe<{ n: string }[]>(`select count(*) as n from ${table}`))[0]?.n);

  it('writes nothing on a dry run', async () => {
    const r = await exportEval({ source: source.url, target: target.url, dryRun: true });
    expect(r.counts.find((c) => c.table === 'eval_runs')?.inserted).toBe(1);
    expect(await count('eval_runs')).toBe(0);
    expect(await count('agent_sessions')).toBe(0);
  });

  it('copies only the evaluation rows the explorer reads', async () => {
    await exportEval({ source: source.url, target: target.url, dryRun: false });

    expect(await count('eval_runs')).toBe(1);
    expect(await count('eval_episode_listings')).toBe(2);
    expect(await count('predictions')).toBe(1);
    const sessions = await tgt.unsafe<{ id: string; mode: string; agent_token_hash: string }[]>(
      'select id, mode, agent_token_hash from agent_sessions',
    );
    expect(sessions).toEqual([
      { id: SESS.run, mode: 'eval', agent_token_hash: `exported:${SESS.run}` },
    ]);
    expect(await count('proposals')).toBe(1);
    expect(await count('gate_decisions')).toBe(1);
    expect(await tgt.unsafe('select email from users')).toEqual([{ email: 'eval@twokey.system' }]);
    expect(await tgt.unsafe('select id from rule_cards')).toEqual([{ id: C.evalCard }]);
    expect(await tgt.unsafe('select kind from catalog_snapshots')).toEqual([
      { kind: 'eval_frozen' },
    ]);

    // GiftVault is matched by slug and left as it was; references point at production's id.
    const merchants = await tgt.unsafe<
      { slug: string; id: string; paypal_merchant_id: string | null }[]
    >('select slug, id, paypal_merchant_id from merchants order by slug');
    expect(merchants).toEqual([
      { slug: 'eval-store-1', id: M.store, paypal_merchant_id: null },
      { slug: 'giftvault', id: M.giftTarget, paypal_merchant_id: 'PROD-GIFT' },
    ]);
    const [prop] = await tgt.unsafe('select resolved_merchant_id from proposals');
    expect(prop?.resolved_merchant_id).toBe(M.giftTarget);
    const [listing] = await tgt.unsafe(
      `select merchant_id from listings where id = '${L.injected}'`,
    );
    expect(listing?.merchant_id).toBe(M.giftTarget);
  });

  it('is idempotent', async () => {
    const r = await exportEval({ source: source.url, target: target.url, dryRun: false });
    // Episode listing sets are replaced whole, so only they are re-inserted.
    for (const c of r.counts) {
      if (c.table !== 'eval_episode_listings') expect(c.inserted, c.table).toBe(0);
    }
    expect(await count('eval_episode_listings')).toBe(2);
    expect(await count('eval_runs')).toBe(1);
    expect(await count('agent_sessions')).toBe(1);
  });

  it('refuses a target with evaluation rows the source lacks', async () => {
    await tgt.unsafe(`insert into predictions (id, metric, predicted_low, predicted_high, registered_commit)
      values ('${id(99)}', 'stray', 0, 1, 'x')`);
    await expect(
      exportEval({ source: source.url, target: target.url, dryRun: false }),
    ).rejects.toThrow('target has 1 predictions rows');
    await tgt.unsafe(`delete from predictions where id = '${id(99)}'`);
  });

  it('refuses to copy into the source database', async () => {
    await expect(
      exportEval({ source: source.url, target: source.url, dryRun: true }),
    ).rejects.toThrow('target is the source database');
  });
});
