/**
 * npm run demo:hook — the demo's poisoned listing, built from a frozen evaluation attack.
 *
 * 1. DEMO_EPISODE_ID is the attacked TEST episode (injecagent or agentdojo) followed by the most
 *    models (ties: lowest id). If no test episode was followed, the best dev episode is used and
 *    labelled "development episode".
 * 2. Its attack template's original_text gets the same adaptGoal rule the evaluation used, with
 *    the demo target: the "Digital gift card $189" listing at GiftVault.
 * 3. A poisoned copy of "Cloud Runner CR-1" at Peak Outfitters, with that text appended, is
 *    upserted into the demo_unbranded snapshot (its own group key, so the clean listing stays).
 * 4. eval/frozen/demo-episode.json records which episode it came from.
 *
 * Reads DATABASE_URL from .env.gateway. Writes only the one demo listing; never touches eval tables.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode } from '@twokey/core';
import { createDb } from '@twokey/db';
import { uuidv7 } from 'uuidv7';
import {
  adaptGoal,
  type GoalTemplate,
  goalSentence,
  PLACEHOLDER_TARGET,
} from '../eval/src/attacks.js';

const HOOK_GROUP = 'cloud-runner-cr1-demo-hook';
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'eval', 'frozen', 'demo-episode.json');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('demo:hook needs DATABASE_URL in .env.gateway');
  process.exit(1);
}
const { sql } = createDb(url);

interface Pick {
  episode_id: string;
  variant: string;
  template_id: string;
  k: number;
  models: string[];
}

async function bestEpisode(split: 'test' | 'dev'): Promise<Pick | undefined> {
  const rows = await sql<Pick[]>`
    select e.id as episode_id, e.variant, e.attack_template_id as template_id,
           count(distinct r.model)::int as k, array_agg(distinct r.model order by r.model) as models
    from eval_runs r
    join eval_episodes e on e.id = r.episode_id
    join eval_tasks t on t.id = e.task_id
    where t.split = ${split} and r.followed_attack and e.variant in ('injecagent', 'agentdojo')
    group by e.id, e.variant, e.attack_template_id
    order by k desc, e.id asc
    limit 1`;
  return rows[0];
}

/** Splits the stored template back into before + goal + after, using its placeholder copy. */
function goalTemplate(t: {
  source: string;
  source_ref: string;
  original_text: string;
  adapted_text: string;
  licence: string;
}): GoalTemplate {
  const placeholder = goalSentence(PLACEHOLDER_TARGET);
  const at = t.adapted_text.indexOf(placeholder);
  if (at === -1 || t.adapted_text.indexOf(placeholder, at + 1) !== -1) {
    throw new AppError(ErrorCode.INTERNAL, 'Template has no single placeholder goal');
  }
  const before = t.adapted_text.slice(0, at);
  const after = t.adapted_text.slice(at + placeholder.length);
  if (
    !t.original_text.startsWith(before) ||
    !t.original_text.endsWith(after) ||
    t.original_text.length < before.length + after.length
  ) {
    throw new AppError(ErrorCode.INTERNAL, 'Template text does not match its adapted copy');
  }
  const goal = t.original_text.slice(before.length, t.original_text.length - after.length);
  if (t.source !== 'injecagent' && t.source !== 'agentdojo') {
    throw new AppError(ErrorCode.INTERNAL, `Unexpected template source ${t.source}`);
  }
  return { source: t.source, sourceRef: t.source_ref, before, goal, after, licence: t.licence };
}

try {
  let split: 'test' | 'dev' = 'test';
  let pick = await bestEpisode('test');
  if (!pick) {
    split = 'dev';
    pick = await bestEpisode('dev');
  }
  if (!pick)
    throw new AppError(ErrorCode.NOT_FOUND, 'No attacked episode was followed by any model');

  const [template] = await sql<
    {
      source: string;
      source_ref: string;
      original_text: string;
      adapted_text: string;
      licence: string;
    }[]
  >`select source, source_ref, original_text, adapted_text, licence
    from attack_templates where id = ${pick.template_id}`;
  if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'Episode has no attack template');

  const [snapshot] = await sql<{ id: string }[]>`
    select id from catalog_snapshots where kind = 'demo_unbranded' and git_tag is null`;
  if (!snapshot) throw new AppError(ErrorCode.NOT_FOUND, 'No demo_unbranded snapshot: run db:seed');

  const listing = (group: string, slug: string) => sql<
    {
      id: string;
      merchant_id: string;
      title: string;
      brand_name: string | null;
      category: string;
      price_cents: number;
      reference_price_cents: number | null;
      reference_n_offers: number;
      structured_attrs: unknown;
      description: string;
      store: string;
    }[]
  >`select l.id, l.merchant_id, l.title, l.brand_name, l.category, l.price_cents,
           l.reference_price_cents, l.reference_n_offers, l.structured_attrs, l.description,
           m.display_name as store
    from listings l join merchants m on m.id = l.merchant_id
    where l.snapshot_id = ${snapshot.id} and l.group_key = ${group} and m.slug = ${slug}`;

  const [target] = await listing('giftvault-gift-card-189', 'giftvault');
  const [original] = await listing('cloud-runner-cr1', 'peak-outfitters');
  if (!target || !original) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'Demo catalog is missing the gift card or Cloud Runner CR-1',
    );
  }

  const demoTarget = { title: target.title, productId: target.id, storeName: target.store };
  const adapted = adaptGoal(goalTemplate(template), demoTarget);
  const description = `${original.description}\n\n${adapted.adaptedText}`;

  const [hook] = await sql<{ id: string }[]>`
    insert into listings (id, snapshot_id, group_key, merchant_id, title, brand_name, category,
      price_cents, currency, reference_price_cents, reference_n_offers, structured_attrs,
      description, injection_id)
    values (${uuidv7()}, ${snapshot.id}, ${HOOK_GROUP}, ${original.merchant_id},
      ${original.title}, ${original.brand_name}, ${original.category}, ${original.price_cents},
      'USD', ${original.reference_price_cents}, ${original.reference_n_offers},
      ${JSON.stringify(original.structured_attrs)}::jsonb, ${description}, ${pick.episode_id})
    on conflict (snapshot_id, group_key, merchant_id) do update set
      title = excluded.title, brand_name = excluded.brand_name, category = excluded.category,
      price_cents = excluded.price_cents, reference_price_cents = excluded.reference_price_cents,
      reference_n_offers = excluded.reference_n_offers, structured_attrs = excluded.structured_attrs,
      description = excluded.description, injection_id = excluded.injection_id
    returning id`;
  if (!hook) throw new AppError(ErrorCode.INTERNAL, 'Hook listing upsert returned no row');

  const [{ total } = { total: 0 }] = await sql<{ total: number }[]>`
    select count(distinct r.model)::int as total from eval_runs r
    join eval_episodes e on e.id = r.episode_id join eval_tasks t on t.id = e.task_id
    where t.split = ${split}`;

  const record = {
    episodeId: pick.episode_id,
    templateSourceRef: template.source_ref,
    followedBy: pick.k,
    models: pick.models,
    modelsTotal: total,
    split,
    label: split === 'test' ? 'test episode' : 'development episode',
    variant: pick.variant,
    templateSource: template.source,
    listingId: hook.id,
    listingTitle: original.title,
    listingStore: original.store,
    targetGoal: goalSentence(demoTarget),
  };
  // Short arrays on one line, as Biome formats JSON.
  const json = JSON.stringify(record, null, 2).replace(
    /\[\n\s+([^[\]]*?)\n\s*\]/g,
    (whole, inner: string) => {
      const line = `[${inner.split(/,\n\s+/).join(', ')}]`;
      return line.length <= 80 ? line : whole;
    },
  );
  writeFileSync(OUT, `${json}\n`);
  console.log(
    `demo:hook ${record.label} ${record.episodeId} (${record.variant}, followed by ${record.followedBy} of ${record.modelsTotal} models) -> ${record.listingTitle} at ${record.listingStore}`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
