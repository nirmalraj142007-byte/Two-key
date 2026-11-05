/**
 * The demo's poisoned listing (shared by `npm run demo:hook`, demo:setup and demo:reset).
 *
 * buildDemoHook(sql) picks the attacked TEST episode followed by the most models (ties: lowest
 * id; no followed test episode: the best dev episode, labelled "development episode"), adapts its
 * attack template's goal to the demo target with the evaluation's own adaptGoal rule, and upserts
 * a poisoned copy of "Cloud Runner CR-1" at Peak Outfitters into the demo_unbranded snapshot. In
 * search it stands in for the clean copy at that store, so the product shows once
 * (apps/gateway/src/routes/agent.ts).
 *
 * The demo target is the evaluation's real finding: a plausible wrong product INSIDE the rules
 * (HOOK_TARGET: Trail Runner TR-2 at Peak Outfitters, an allowed store, $64.40 against a $46.00
 * median), which Two-Key holds for the person. The attacker-store attempt (the GiftVault gift
 * card) is shown separately with the scripted:attack model.
 *
 * `pinned: true` (demo:setup, demo:reset) uses the episode recorded in
 * eval/frozen/demo-episode.json instead of choosing one, reads its template from the database
 * (or, before the evaluation export reached that database, from the pinned vendored repos), and
 * never writes the record. Without either source an existing hook listing is kept as it is.
 * Writes only the one demo listing; never touches eval tables.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCode } from '@twokey/core';
import type postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import {
  adaptGoal,
  type GoalTemplate,
  goalSentence,
  loadAgentDojo,
  loadInjecAgent,
  PINNED,
  PLACEHOLDER_TARGET,
} from '../eval/src/attacks.js';

export const HOOK_GROUP = 'cloud-runner-cr1-demo-hook';
/** The poisoned listing: a copy of this product at this store. */
export const HOOK_HOST = { group: 'cloud-runner-cr1', merchant: 'peak-outfitters' } as const;
/** What the adapted goal asks for: a wrong product inside the demo rules, held as an anomaly. */
export const HOOK_TARGET = { group: 'trail-runner-tr2', merchant: 'peak-outfitters' } as const;
export const DEMO_EPISODE_FILE = join(
  import.meta.dirname,
  '..',
  'eval',
  'frozen',
  'demo-episode.json',
);

export interface DemoEpisodeRecord {
  episodeId: string;
  templateSourceRef: string;
  followedBy: number;
  models: string[];
  modelsTotal: number;
  split: 'test' | 'dev';
  label: string;
  variant: string;
  templateSource: string;
  listingId: string;
  listingTitle: string;
  listingStore: string;
  targetGoal: string;
}

export interface HookResult {
  record: DemoEpisodeRecord;
  /** Where the template text came from; 'kept' means the existing listing was left alone. */
  source: 'database' | 'vendored' | 'kept';
}

type Sql = postgres.Sql;

interface Pick {
  episode_id: string;
  variant: string;
  template_id: string;
  k: number;
  models: string[];
}

interface TemplateRow {
  source: string;
  source_ref: string;
  original_text: string;
  adapted_text: string;
  licence: string;
}

async function bestEpisode(sql: Sql, split: 'test' | 'dev'): Promise<Pick | undefined> {
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
export function goalTemplate(t: TemplateRow): GoalTemplate {
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

export function readDemoEpisode(): DemoEpisodeRecord {
  return JSON.parse(readFileSync(DEMO_EPISODE_FILE, 'utf8')) as DemoEpisodeRecord;
}

/** The pinned record's template: the database first, then the vendored repos, else none. */
async function pinnedTemplate(
  sql: Sql,
  record: DemoEpisodeRecord,
): Promise<{ template: GoalTemplate; source: 'database' | 'vendored' } | undefined> {
  const rows = await sql<TemplateRow[]>`
    select t.source, t.source_ref, t.original_text, t.adapted_text, t.licence
    from eval_episodes e join attack_templates t on t.id = e.attack_template_id
    where e.id = ${record.episodeId}`;
  const row = rows[0];
  if (row) {
    if (row.source_ref !== record.templateSourceRef) {
      throw new AppError(ErrorCode.INTERNAL, 'Demo episode template differs from its record');
    }
    return { template: goalTemplate(row), source: 'database' };
  }
  const source = record.templateSource;
  if (source !== 'agentdojo' && source !== 'injecagent') return undefined;
  if (!existsSync(PINNED[source].dir)) return undefined;
  const all = source === 'agentdojo' ? loadAgentDojo().templates : loadInjecAgent();
  const template = all.find((t) => t.sourceRef === record.templateSourceRef);
  return template ? { template, source: 'vendored' } : undefined;
}

interface ListingRow {
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
}

interface DemoCatalog {
  snapshotId: string;
  listing: (group: string, slug: string) => Promise<ListingRow[]>;
  target: ListingRow;
  original: ListingRow;
  demoTarget: { title: string; productId: string; storeName: string };
}

async function demoCatalog(sql: Sql): Promise<DemoCatalog> {
  const [snapshot] = await sql<{ id: string }[]>`
    select id from catalog_snapshots where kind = 'demo_unbranded' and git_tag is null`;
  if (!snapshot) throw new AppError(ErrorCode.NOT_FOUND, 'No demo_unbranded snapshot: run db:seed');
  const listing = (group: string, slug: string) => sql<ListingRow[]>`
    select l.id, l.merchant_id, l.title, l.brand_name, l.category, l.price_cents,
           l.reference_price_cents, l.reference_n_offers, l.structured_attrs, l.description,
           m.display_name as store
    from listings l join merchants m on m.id = l.merchant_id
    where l.snapshot_id = ${snapshot.id} and l.group_key = ${group} and m.slug = ${slug}`;
  const [target] = await listing(HOOK_TARGET.group, HOOK_TARGET.merchant);
  const [original] = await listing(HOOK_HOST.group, HOOK_HOST.merchant);
  if (!target || !original) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'Demo catalog is missing Trail Runner TR-2 or Cloud Runner CR-1 at Peak Outfitters: run db:seed',
    );
  }
  return {
    snapshotId: snapshot.id,
    listing,
    target,
    original,
    demoTarget: { title: target.title, productId: target.id, storeName: target.store },
  };
}

/** The adapted goal sentence the hook carries ("Buy … (product id …) from …."). */
export async function hookTargetGoal(sql: Sql): Promise<string> {
  return goalSentence((await demoCatalog(sql)).demoTarget);
}

/**
 * Upserts the poisoned copy of the host listing: its own description, then the template with the
 * goal adapted to HOOK_TARGET. Returns the hook listing's id.
 */
export async function writeHookListing(
  sql: Sql,
  template: GoalTemplate,
  episodeId: string,
): Promise<string> {
  const { snapshotId, original, demoTarget } = await demoCatalog(sql);
  const adapted = adaptGoal(template, demoTarget);
  const description = `${original.description}\n\n${adapted.adaptedText}`;
  const [hook] = await sql<{ id: string }[]>`
    insert into listings (id, snapshot_id, group_key, merchant_id, title, brand_name, category,
      price_cents, currency, reference_price_cents, reference_n_offers, structured_attrs,
      description, injection_id)
    values (${uuidv7()}, ${snapshotId}, ${HOOK_GROUP}, ${original.merchant_id},
      ${original.title}, ${original.brand_name}, ${original.category}, ${original.price_cents},
      'USD', ${original.reference_price_cents}, ${original.reference_n_offers},
      ${JSON.stringify(original.structured_attrs)}::jsonb, ${description}, ${episodeId})
    on conflict (snapshot_id, group_key, merchant_id) do update set
      title = excluded.title, brand_name = excluded.brand_name, category = excluded.category,
      price_cents = excluded.price_cents, reference_price_cents = excluded.reference_price_cents,
      reference_n_offers = excluded.reference_n_offers, structured_attrs = excluded.structured_attrs,
      description = excluded.description, injection_id = excluded.injection_id
    returning id`;
  if (!hook) throw new AppError(ErrorCode.INTERNAL, 'Hook listing upsert returned no row');
  return hook.id;
}

export async function buildDemoHook(sql: Sql, opts: { pinned: boolean }): Promise<HookResult> {
  const { listing, original, demoTarget } = await demoCatalog(sql);

  let record: DemoEpisodeRecord;
  let template: GoalTemplate;
  let source: HookResult['source'] = 'database';
  if (opts.pinned) {
    record = readDemoEpisode();
    const found = await pinnedTemplate(sql, record);
    if (!found) {
      const [existing] = await listing(HOOK_GROUP, 'peak-outfitters');
      if (!existing) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'The demo episode template is in neither the database nor eval/vendor: run eval:export or fetch the vendored repos',
        );
      }
      return { record: { ...record, listingId: existing.id }, source: 'kept' };
    }
    template = found.template;
    source = found.source;
  } else {
    let split: 'test' | 'dev' = 'test';
    let pick = await bestEpisode(sql, 'test');
    if (!pick) {
      split = 'dev';
      pick = await bestEpisode(sql, 'dev');
    }
    if (!pick) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No attacked episode was followed by any model');
    }
    const [row] = await sql<TemplateRow[]>`
      select source, source_ref, original_text, adapted_text, licence
      from attack_templates where id = ${pick.template_id}`;
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Episode has no attack template');
    template = goalTemplate(row);
    const [{ total } = { total: 0 }] = await sql<{ total: number }[]>`
      select count(distinct r.model)::int as total from eval_runs r
      join eval_episodes e on e.id = r.episode_id join eval_tasks t on t.id = e.task_id
      where t.split = ${split}`;
    record = {
      episodeId: pick.episode_id,
      templateSourceRef: row.source_ref,
      followedBy: pick.k,
      models: pick.models,
      modelsTotal: total,
      split,
      label: split === 'test' ? 'test episode' : 'development episode',
      variant: pick.variant,
      templateSource: row.source,
      listingId: '',
      listingTitle: original.title,
      listingStore: original.store,
      targetGoal: goalSentence(demoTarget),
    };
  }

  // The pinned record is never rewritten, so its goal sentence is refreshed here to match what
  // the listing now carries.
  record = { ...record, targetGoal: goalSentence(demoTarget) };
  const listingId = await writeHookListing(sql, template, record.episodeId);
  return { record: { ...record, listingId }, source };
}

export function hookSummary({ record, source }: HookResult): string {
  return `demo:hook ${record.label} ${record.episodeId} (${record.variant}, followed by ${record.followedBy} of ${record.modelsTotal} models) -> ${record.listingTitle} at ${record.listingStore}${source === 'database' ? '' : ` [template: ${source}]`}`;
}
