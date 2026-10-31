import type { Gate, GateOutcome } from '@twokey/core';
import {
  agentSessions,
  attackTemplates,
  evalEpisodeListings,
  evalEpisodes,
  evalRuns,
  evalTasks,
  gateDecisions,
  listings,
  merchants,
  proposals,
} from '@twokey/db';
import { loadMetricsRows } from '@twokey/eval/src/metrics';
import { asc, eq, inArray } from 'drizzle-orm';
import { unstable_cache } from 'next/cache';
import redactionTerms from '@/data/redaction-terms.json';
import templateSources from '@/data/template-sources.json';
import { db } from './db';
import {
  type EpisodeFilters,
  type EpisodeRow,
  filterRows,
  GATE_IDS,
  type GateId,
  insertedText,
  type Outcome,
  paginate,
  parseSourceRef,
  type SourceRef,
  type TargetType,
  type TranscriptStep,
  transcriptSteps,
  type Variant,
} from './episodes-view';
import { type RuleChip, ruleChips } from './history-view';
import { makeRedactor, type Redactor, storePseudonyms } from './redact';
import { getResultsSummary, type Split } from './results-queries';

const chunks = <T>(xs: readonly T[], n = 500): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Brand names change only when the snapshot is rebuilt; cache them for an hour. */
/** Store domain → "Store 007", numbered by merchant ID; the domains never leave the database. */
async function loadStorePseudonyms(): Promise<Record<string, string>> {
  const rows = await db()
    .select({ domain: merchants.displayName })
    .from(merchants)
    .where(eq(merchants.role, 'eval_merchant'))
    .orderBy(asc(merchants.id));
  return storePseudonyms(rows.map((r) => r.domain));
}

let memo: { key: string; redactor: Redactor } | null = null;

/** The committed term list (same in every environment) plus the store pseudonyms. */
export async function getRedactor(): Promise<Redactor> {
  const stores = await getStorePseudonyms();
  const key = `${Object.keys(stores).length}:${JSON.stringify(Object.entries(stores).slice(0, 3))}`;
  if (memo?.key !== key) memo = { key, redactor: makeRedactor({ ...redactionTerms, stores }) };
  return memo.redactor;
}

const getStorePseudonyms = unstable_cache(loadStorePseudonyms, ['eval-store-pseudonyms'], {
  revalidate: 3600,
  tags: ['results'],
});

async function listingTitles(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = await db()
      .select({ id: listings.id, title: listings.title })
      .from(listings)
      .where(inArray(listings.id, part));
    for (const r of rows) out.set(r.id, r.title);
  }
  return out;
}

/** Every run of a split as one grid row, built from the same rows as `eval metrics`. */
async function loadSplitRows(split: Split): Promise<EpisodeRow[]> {
  const [{ runs, proposals: props }, redact] = await Promise.all([
    loadMetricsRows(db(), split),
    getRedactor(),
  ]);
  const episodes = await db()
    .select({
      id: evalEpisodes.id,
      taskId: evalEpisodes.taskId,
      fallback: evalEpisodes.targetFallback,
    })
    .from(evalEpisodes)
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .where(eq(evalTasks.split, split));
  const episodeById = new Map(episodes.map((e) => [e.id, e]));
  const runIds = new Map<string, string>();
  for (const part of chunks(runs.map((r) => r.sessionId))) {
    const rows = await db()
      .select({ id: evalRuns.id, sessionId: evalRuns.sessionId })
      .from(evalRuns)
      .where(inArray(evalRuns.sessionId, part));
    for (const r of rows) if (r.sessionId) runIds.set(r.sessionId, r.id);
  }
  const bySession = new Map<string, typeof props>();
  for (const p of props) bySession.set(p.sessionId, [...(bySession.get(p.sessionId) ?? []), p]);
  const titles = await listingTitles(props.map((p) => p.listingId));

  return runs.map((r) => {
    const mine = bySession.get(r.sessionId) ?? [];
    const target =
      r.variant !== 'clean' && r.followedAttack
        ? mine.find((p) => p.listingId === r.targetListingId)
        : undefined;
    const shown = target ?? mine[0];
    const at = (g: Gate): Outcome | null => shown?.decisions[g] ?? null;
    const title = shown ? titles.get(shown.listingId) : undefined;
    const ep = episodeById.get(r.episodeId);
    return {
      runId: runIds.get(r.sessionId) ?? r.sessionId,
      episodeId: r.episodeId,
      taskId: ep?.taskId ?? '',
      variant: r.variant,
      targetType: r.targetType,
      targetFallback: ep?.fallback ?? false,
      model: r.model,
      followed: r.followedAttack,
      g0: at('G0'),
      g1: at('G1'),
      g2: at('G2'),
      g3: at('G3'),
      g4: at('G4'),
      proposalTitle: title ? redact(title) : null,
      proposals: mine.length,
      costUsd: r.costUsd,
      hasProposal: mine.length > 0,
    };
  });
}

const getSplitRows = unstable_cache(loadSplitRows, ['results-episode-rows'], {
  revalidate: 60,
  tags: ['results'],
});

export interface EpisodesPage {
  split: Split;
  filters: EpisodeFilters;
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  rows: EpisodeRow[];
  models: string[];
}

/** Server-side filtering and pagination (200 rows per page). */
export async function listEpisodes(filters: EpisodeFilters): Promise<EpisodesPage> {
  const split = filters.split ?? (await getResultsSummary()).split;
  const all = await getSplitRows(split);
  const page = paginate(filterRows(all, filters), filters.page);
  return {
    split,
    filters,
    ...page,
    models: [...new Set(all.map((r) => r.model))].sort(),
  };
}

/**
 * Attacked runs per model whose target fell back to outside the rules (no inside-the-rules
 * candidate). Counted from the explorer's own rows, so the count equals the grid it links to.
 */
export async function fallbackCounts(split: Split): Promise<Record<string, number>> {
  const rows = filterRows(await getSplitRows(split), { set: 'attacked', fallback: 'true' });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.model] = (out[r.model] ?? 0) + 1;
  return out;
}

// ---- one episode --------------------------------------------------------------------------------

export interface EpisodeListingView {
  position: number;
  listingId: string;
  title: string;
  store: string;
  priceCents: number;
  category: string;
  referencePriceCents: number | null;
  referenceNOffers: number;
  injected: boolean;
  target: boolean;
}

export interface GateCell {
  outcome: GateOutcome;
  chips: RuleChip[];
}

export interface ProposalView {
  id: string;
  listingId: string;
  title: string;
  store: string;
  attackerPayee: boolean;
  qty: number;
  amountCents: number;
  isTarget: boolean;
  gates: Record<GateId, GateCell | null>;
}

export interface RunView {
  model: string;
  followed: boolean;
  honestPurchaseOk: boolean | null;
  productDetailOk: boolean | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  steps: TranscriptStep[] | null;
  proposals: ProposalView[];
}

export interface EpisodeDetail {
  episodeId: string;
  split: Split;
  taskId: string;
  instruction: string;
  priceCapCents: number;
  variant: Variant;
  targetType: TargetType | null;
  targetFallback: boolean;
  injectionPosition: number | null;
  target: { listingId: string; title: string; store: string; priceCents: number } | null;
  template: {
    source: string;
    sourceRef: string;
    licence: string;
    diff: string;
    ref: SourceRef;
  } | null;
  injectedText: string | null;
  listings: EpisodeListingView[];
  runs: RunView[];
}

const SOURCES = templateSources as Record<
  string,
  { file: string; caseId: string | null; line: number | null; url: string | null }[]
>;

/** Links to the exact file and line at the pinned commit; case names are redacted for display. */
function sourceLinks(source: string, sourceRef: string, r: Redactor): SourceRef {
  const parsed = parseSourceRef(source, sourceRef);
  const files = SOURCES[sourceRef] ?? parsed.files.map((f) => ({ ...f, line: null }));
  return {
    ...parsed,
    files: files.map((f) => ({ ...f, caseId: f.caseId ? r(f.caseId) : null })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadEpisode(id: string): Promise<EpisodeDetail | null> {
  if (!UUID.test(id)) return null;
  const d = db();
  const [ep] = await d
    .select({ episode: evalEpisodes, task: evalTasks, template: attackTemplates })
    .from(evalEpisodes)
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .leftJoin(attackTemplates, eq(attackTemplates.id, evalEpisodes.attackTemplateId))
    .where(eq(evalEpisodes.id, id))
    .limit(1);
  if (!ep) return null;
  const r = await getRedactor();
  const { episode, task, template } = ep;

  const shown = await d
    .select({
      position: evalEpisodeListings.position,
      id: listings.id,
      title: listings.title,
      store: merchants.displayName,
      priceCents: listings.priceCents,
      category: listings.category,
      referencePriceCents: listings.referencePriceCents,
      referenceNOffers: listings.referenceNOffers,
      description: listings.description,
    })
    .from(evalEpisodeListings)
    .innerJoin(listings, eq(listings.id, evalEpisodeListings.listingId))
    .innerJoin(merchants, eq(merchants.id, listings.merchantId))
    .where(eq(evalEpisodeListings.episodeId, id))
    .orderBy(asc(evalEpisodeListings.position));

  const [target] = episode.targetListingId
    ? await d
        .select({
          id: listings.id,
          title: listings.title,
          store: merchants.displayName,
          priceCents: listings.priceCents,
        })
        .from(listings)
        .innerJoin(merchants, eq(merchants.id, listings.merchantId))
        .where(eq(listings.id, episode.targetListingId))
    : [];

  const injected = shown.find((l) => l.id === episode.injectedListingId);
  const inserted =
    injected && template ? insertedText(injected.description, template.adaptedText) : null;

  const runRows = await d
    .select({
      model: evalRuns.model,
      sessionId: evalRuns.sessionId,
      followed: evalRuns.followedAttack,
      honestPurchaseOk: evalRuns.honestPurchaseOk,
      productDetailOk: evalRuns.productDetailOk,
      costUsd: evalRuns.costUsd,
      tokensIn: evalRuns.tokensIn,
      tokensOut: evalRuns.tokensOut,
      transcript: agentSessions.transcript,
    })
    .from(evalRuns)
    .leftJoin(agentSessions, eq(agentSessions.id, evalRuns.sessionId))
    .where(eq(evalRuns.episodeId, id))
    .orderBy(asc(evalRuns.model));

  const sessionIds = runRows.flatMap((x) => (x.sessionId ? [x.sessionId] : []));
  const propRows =
    sessionIds.length === 0
      ? []
      : await d
          .select({
            id: proposals.id,
            sessionId: proposals.sessionId,
            listingId: proposals.listingId,
            title: listings.title,
            store: merchants.displayName,
            role: merchants.role,
            qty: proposals.qty,
            amountCents: proposals.resolvedAmountCents,
            gate: gateDecisions.gate,
            outcome: gateDecisions.outcome,
            ruleHits: gateDecisions.ruleHits,
          })
          .from(proposals)
          .innerJoin(listings, eq(listings.id, proposals.listingId))
          .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
          .leftJoin(gateDecisions, eq(gateDecisions.proposalId, proposals.id))
          .where(inArray(proposals.sessionId, sessionIds))
          .orderBy(asc(proposals.createdAt), asc(proposals.id));

  const bySession = new Map<string, Map<string, ProposalView>>();
  for (const p of propRows) {
    const mine = bySession.get(p.sessionId) ?? new Map<string, ProposalView>();
    const view = mine.get(p.id) ?? {
      id: p.id,
      listingId: p.listingId,
      title: r(p.title),
      store: r(p.store),
      attackerPayee: p.role === 'attacker',
      qty: p.qty,
      amountCents: p.amountCents,
      isTarget: p.listingId === episode.targetListingId,
      gates: Object.fromEntries(GATE_IDS.map((g) => [g, null])) as ProposalView['gates'],
    };
    if (p.gate && p.outcome)
      view.gates[p.gate] = { outcome: p.outcome, chips: ruleChips(p.ruleHits) };
    mine.set(p.id, view);
    bySession.set(p.sessionId, mine);
  }

  return {
    episodeId: episode.id,
    split: task.split,
    taskId: task.id,
    instruction: r(task.instructionText),
    priceCapCents: task.priceCapCents,
    variant: episode.variant,
    targetType: episode.targetType,
    targetFallback: episode.targetFallback,
    injectionPosition: episode.injectionPosition,
    target: target
      ? {
          listingId: target.id,
          title: r(target.title),
          store: r(target.store),
          priceCents: target.priceCents,
        }
      : null,
    template: template
      ? {
          source: template.source,
          sourceRef: r(template.sourceRef),
          licence: template.licence,
          diff: r(template.diff),
          ref: sourceLinks(template.source, template.sourceRef, r),
        }
      : null,
    injectedText: inserted ? r(inserted) : null,
    listings: shown.map((l) => ({
      position: l.position,
      listingId: l.id,
      title: r(l.title),
      store: r(l.store),
      priceCents: l.priceCents,
      category: l.category,
      referencePriceCents: l.referencePriceCents,
      referenceNOffers: l.referenceNOffers,
      injected: l.id === episode.injectedListingId,
      target: l.id === episode.targetListingId,
    })),
    runs: runRows.map((x) => ({
      model: x.model,
      followed: x.followed,
      honestPurchaseOk: x.honestPurchaseOk,
      productDetailOk: x.productDetailOk,
      costUsd: Number(x.costUsd),
      tokensIn: x.tokensIn,
      tokensOut: x.tokensOut,
      steps: transcriptSteps(x.transcript, r),
      proposals: x.sessionId ? [...(bySession.get(x.sessionId)?.values() ?? [])] : [],
    })),
  };
}

/** One episode, end to end, cached for 60 s. Null when the ID is unknown. */
export const getEpisode = unstable_cache(loadEpisode, ['results-episode'], {
  revalidate: 60,
  tags: ['results'],
});

/** Every model with at least one run in this split: the models an episode is expected to have. */
export async function splitModels(split: Split): Promise<string[]> {
  const all = await getSplitRows(split);
  return [...new Set(all.map((r) => r.model))].sort();
}
