import type { Channel3Api } from '@channel3/sdk';
import { AppError, ErrorCode } from '@twokey/core';
import type { GoalTemplate } from './attacks.js';
import { categorize, UNMAPPED_CATEGORY } from './categories.js';
import {
  assertCardValid,
  type BuiltEpisode,
  type BuiltTask,
  type BuiltTemplate,
  buildEpisodes,
  buildTemplates,
  evalCard,
} from './episodes.js';
import {
  ATTACKER_SLUG,
  giftCardListings,
  mapResults,
  type SnapshotListing,
  type SnapshotMerchant,
} from './snapshot.js';
import { canonicalJson, median, rng, SAMPLE_SEED, sha256, shuffle, stableUuid } from './util.js';
import {
  type CapDraw,
  explicitPriceCapDollars,
  instructionWithCap,
  searchQuery,
  type WebshopInstruction,
  webshopCapDraw,
} from './webshop.js';

export type Search = (taskId: string, query: string) => Promise<Channel3Api.Product[]>;

export interface DatasetInput {
  instructions: readonly WebshopInstruction[];
  templates: { injecagent: readonly GoalTemplate[]; agentdojo: readonly GoalTemplate[] };
  search: Search;
  /** 200 in the real build: the first `devCount` accepted are dev, the rest test. */
  sampleSize: number;
  devCount: number;
}

export interface Dataset {
  tasks: BuiltTask[];
  templates: BuiltTemplate[];
  episodes: BuiltEpisode[];
  /** Every listing in the eval_frozen snapshot: results, gift cards, injected copies. */
  listings: SnapshotListing[];
  merchants: SnapshotMerchant[];
  snapshotSha256: string;
  episodesSha256: string;
  stats: {
    examined: number;
    rejectedNoResults: number;
    rejectedNoCap: number;
    unmappedCategories: string[];
    tasksWithListingUnderCap: number;
    tasksWithoutListingUnderCap: number;
  };
}

export function taskIdFor(instructionId: string): string {
  return stableUuid(`task:${instructionId}`);
}

export function capSeed(instructionId: string): string {
  return `${SAMPLE_SEED}:cap:${instructionId}`;
}

/** sha256 over the sorted episode hashes, the manifest's episodeHashes value. */
export function episodesDigest(hashes: readonly string[]): string {
  return sha256([...hashes].sort().join('\n'));
}

export async function buildDataset(input: DatasetInput): Promise<Dataset> {
  const order = shuffle(input.instructions, rng(SAMPLE_SEED));
  const listings = new Map<string, SnapshotListing>();
  const merchants = new Map<string, SnapshotMerchant>();
  const tasks: BuiltTask[] = [];
  const unmapped: string[] = [];
  let examined = 0;
  let rejectedNoResults = 0;
  let rejectedNoCap = 0;

  for (const item of order) {
    if (tasks.length >= input.sampleSize) break;
    examined++;
    const id = taskIdFor(item.id);
    const query = searchQuery(item.instruction);
    const mapped = mapResults(await input.search(id, query));
    if (mapped.listings.length === 0) {
      rejectedNoResults++;
      continue;
    }
    // First-seen wins, so a product shared by two tasks has one frozen version.
    const resultListings = mapped.listings.map((l) => {
      const existing = listings.get(l.id);
      return existing ?? l;
    });

    const explicit = explicitPriceCapDollars(item);
    let draw: CapDraw | null;
    if (explicit !== null) {
      draw = {
        method: 'explicit',
        basePriceCents: null,
        seed: null,
        priceRangeDollars: [],
        sampledDollars: [],
        priceUpperDollars: explicit,
      };
    } else {
      const base = median(resultListings.map((l) => l.priceCents));
      draw = webshopCapDraw(base, capSeed(item.id));
    }
    if (!draw) {
      rejectedNoCap++;
      continue;
    }

    for (const l of resultListings) listings.set(l.id, l);
    for (const m of mapped.merchants) merchants.set(m.slug, m);

    const priceCapCents = Math.round(draw.priceUpperDollars * 100);
    const mappedCategory = categorize(item.instruction);
    if (!mappedCategory) unmapped.push(item.instruction);
    const category = mappedCategory ?? UNMAPPED_CATEGORY;
    const merchantIds = [
      ...new Set(
        resultListings
          .filter((l) => l.merchantSlug !== ATTACKER_SLUG)
          .map((l) => (merchants.get(l.merchantSlug) as SnapshotMerchant).id),
      ),
    ];
    const card = evalCard(priceCapCents, merchantIds);
    assertCardValid(card);
    const index = tasks.length;
    tasks.push({
      id,
      index,
      split: index < input.devCount ? 'dev' : 'test',
      webshopInstructionId: item.id,
      instructionText: instructionWithCap(item.instruction, draw.priceUpperDollars),
      priceCapCents,
      category,
      goalAttrs: {
        asin: item.asin,
        originalInstruction: item.instruction,
        searchQuery: query,
        instructionAttributes: item.instructionAttributes,
        instructionOptions: item.instructionOptions,
        sampleIndex: index,
        capDraw: draw,
        evalCard: card,
      },
      sampleSeed: SAMPLE_SEED,
      resultListingIds: resultListings.map((l) => l.id),
    });
  }

  if (tasks.length < input.sampleSize) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `Only ${tasks.length} of ${input.sampleSize} tasks have Channel3 results and a cap`,
    );
  }

  for (const card of giftCardListings()) listings.set(card.id, card);
  const templates = buildTemplates([...input.templates.injecagent, ...input.templates.agentdojo]);
  const { episodes, injectedListings } = buildEpisodes({
    tasks,
    listings,
    merchants,
    templates: {
      injecagent: templates.filter((t) => t.source === 'injecagent'),
      agentdojo: templates.filter((t) => t.source === 'agentdojo'),
    },
  });
  for (const l of injectedListings) listings.set(l.id, l);

  const allListings = [...listings.values()].sort((a, b) => a.id.localeCompare(b.id));
  let withUnderCap = 0;
  for (const task of tasks) {
    const ok = task.resultListingIds.some((id) => {
      const l = listings.get(id) as SnapshotListing;
      return l.merchantSlug !== ATTACKER_SLUG && l.priceCents <= task.priceCapCents;
    });
    if (ok) withUnderCap++;
  }

  return {
    tasks,
    templates,
    episodes,
    listings: allListings,
    merchants: [...merchants.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    snapshotSha256: sha256(canonicalJson(allListings)),
    episodesSha256: episodesDigest(episodes.map((e) => e.contentSha256)),
    stats: {
      examined,
      rejectedNoResults,
      rejectedNoCap,
      unmappedCategories: unmapped,
      tasksWithListingUnderCap: withUnderCap,
      tasksWithoutListingUnderCap: tasks.length - withUnderCap,
    },
  };
}
