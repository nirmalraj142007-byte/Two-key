import { existsSync, readFileSync } from 'node:fs';
import {
  AppError,
  decideGate,
  ErrorCode,
  GATE_VERSION,
  type Gate,
  type GateOutcome,
  type Listing,
  type RuleCard,
  RuleCardSchema,
  type RuleHit,
} from '@twokey/core';
import {
  type Db,
  evalEpisodes,
  evalRuns,
  evalTasks,
  gateDecisions,
  listings,
  proposals,
  ruleCards,
} from '@twokey/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildManifest, MANIFEST_PATH, type Manifest } from './freeze.js';
import { GATES } from './metrics.js';
import type { Split } from './run.js';
import { canonicalJson } from './util.js';

export interface ReplayInput {
  proposalId: string;
  qty: number;
  listing: Listing;
  card: RuleCard;
  taskCapCents: number;
  staticCapCents: number;
  now: Date;
}

/** G0..G4 for one recorded proposal. Pure: the same inputs always give the same decisions. */
export function replayGates(
  i: ReplayInput,
): Record<Gate, { outcome: GateOutcome; hits: RuleHit[] }> {
  const input = {
    card: i.card,
    taskCapCents: i.taskCapCents,
    staticCapCents: i.staticCapCents,
    listing: i.listing,
    qty: i.qty,
    now: i.now,
    // Eval sessions never create payments, so the frequency rule always counts zero.
    recentPurchaseCount: 0,
  };
  const out = {} as Record<Gate, { outcome: GateOutcome; hits: RuleHit[] }>;
  for (const g of GATES) out[g] = decideGate(g, input);
  return out;
}

/** The frozen manifest's static cap; before the freeze, the same value computed from the DB. */
export async function staticCap(db: Db): Promise<{ cents: number; source: string }> {
  if (existsSync(MANIFEST_PATH)) {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    return { cents: m.staticCapCents, source: MANIFEST_PATH };
  }
  return {
    cents: (await buildManifest(db)).staticCapCents,
    source: 'buildManifest (not frozen yet)',
  };
}

/**
 * The card G4 replays with: the gateway-signed card of the session, checked to be exactly the
 * task's evalCard. The HMAC itself is verified by the gateway at decision time; the eval CLI
 * never holds the signing key.
 */
function taskCard(
  proposalId: string,
  stored: { status: string; rules: unknown },
  evalCard: unknown,
): RuleCard {
  const card = RuleCardSchema.safeParse(stored.rules);
  if (stored.status !== 'signed' || !card.success) {
    throw new AppError(ErrorCode.RULE_CARD_INVALID, `Proposal ${proposalId}: card is not signed`);
  }
  const expected = RuleCardSchema.safeParse({
    ...(evalCard as object),
    userId: card.data.userId,
    version: card.data.version,
  });
  if (!expected.success || canonicalJson(expected.data) !== canonicalJson(card.data)) {
    throw new AppError(
      ErrorCode.RULE_CARD_INVALID,
      `Proposal ${proposalId}: signed card differs from the task's eval card`,
    );
  }
  return card.data;
}

export interface ReplaySummary {
  proposals: number;
  decisionsWritten: number;
  staticCapCents: number;
  staticCapSource: string;
}

export interface ReplayedProposal {
  proposalId: string;
  decisions: Record<Gate, { outcome: GateOutcome; hits: RuleHit[] }>;
  hasLiveG4: boolean;
}

/**
 * Recomputes G0..G4 for every recorded proposal, in memory. With `anomalyThreshold` the task
 * card's priceRatioThreshold is replaced (what-if analysis only; the live check is then skipped,
 * since the stored G4 used the real threshold).
 */
export async function computeReplay(
  db: Db,
  split: Split,
  models?: readonly string[],
  opts: { anomalyThreshold?: number } = {},
): Promise<{ cap: { cents: number; source: string }; decided: ReplayedProposal[] }> {
  const cap = await staticCap(db);
  const rows = await db
    .select({
      proposalId: proposals.id,
      qty: proposals.qty,
      createdAt: proposals.createdAt,
      listingId: listings.id,
      merchantId: listings.merchantId,
      snapshotId: listings.snapshotId,
      priceCents: listings.priceCents,
      category: listings.category,
      referencePriceCents: listings.referencePriceCents,
      referenceOffers: listings.referenceNOffers,
      taskCapCents: evalTasks.priceCapCents,
      goalAttrs: evalTasks.goalAttrs,
      cardStatus: ruleCards.status,
      cardRules: ruleCards.rules,
    })
    .from(evalRuns)
    .innerJoin(evalEpisodes, eq(evalEpisodes.id, evalRuns.episodeId))
    .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
    .innerJoin(proposals, eq(proposals.sessionId, evalRuns.sessionId))
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(ruleCards, eq(ruleCards.id, proposals.ruleCardId))
    .where(
      and(
        eq(evalTasks.split, split),
        models && models.length > 0 ? inArray(evalRuns.model, [...models]) : undefined,
      ),
    );
  if (rows.length === 0) return { cap, decided: [] };

  // Category medians exactly as the gateway's resolveListing computes them.
  const medians = await db
    .select({
      snapshotId: listings.snapshotId,
      category: listings.category,
      cents: sql<
        number | null
      >`round(percentile_cont(0.5) within group (order by ${listings.priceCents}))::int`,
    })
    .from(listings)
    .where(inArray(listings.snapshotId, [...new Set(rows.map((r) => r.snapshotId))]))
    .groupBy(listings.snapshotId, listings.category);
  const medianOf = new Map(medians.map((m) => [`${m.snapshotId}|${m.category}`, m.cents]));

  const ids = rows.map((r) => r.proposalId);
  const stored = new Map<string, GateOutcome>();
  for (let i = 0; i < ids.length; i += 500) {
    const live = await db
      .select({ proposalId: gateDecisions.proposalId, outcome: gateDecisions.outcome })
      .from(gateDecisions)
      .where(
        and(inArray(gateDecisions.proposalId, ids.slice(i, i + 500)), eq(gateDecisions.gate, 'G4')),
      );
    for (const d of live) stored.set(d.proposalId, d.outcome);
  }

  const override = opts.anomalyThreshold;
  const decided = rows.map((r): ReplayedProposal => {
    const median = medianOf.get(`${r.snapshotId}|${r.category}`) ?? null;
    const evalCard = (r.goalAttrs as { evalCard?: unknown }).evalCard;
    const card = taskCard(r.proposalId, { status: r.cardStatus, rules: r.cardRules }, evalCard);
    const decisions = replayGates({
      proposalId: r.proposalId,
      qty: r.qty,
      listing: {
        id: r.listingId,
        merchantId: r.merchantId,
        priceCents: r.priceCents,
        category: r.category,
        referencePriceCents: r.referencePriceCents,
        referenceOffers: r.referenceOffers,
        categoryMedianCents: median && median > 0 ? median : null,
      },
      card:
        override === undefined
          ? card
          : { ...card, anomaly: { ...card.anomaly, priceRatioThreshold: override } },
      taskCapCents: r.taskCapCents,
      staticCapCents: cap.cents,
      now: r.createdAt,
    });
    // Consistency check: the offline G4 must equal what the gateway decided live.
    const live = stored.get(r.proposalId);
    if (override === undefined && live !== undefined && live !== decisions.G4.outcome) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Replay mismatch on proposal ${r.proposalId}: live G4 ${live}, replayed ${decisions.G4.outcome}`,
      );
    }
    return { proposalId: r.proposalId, decisions, hasLiveG4: live !== undefined };
  });
  return { cap, decided };
}

/** Replays at the card's own threshold and stores G0..G3 (and G4 where no live one exists). */
export async function replay(
  db: Db,
  split: Split,
  models?: readonly string[],
): Promise<ReplaySummary> {
  const { cap, decided } = await computeReplay(db, split, models);
  let written = 0;
  await db.transaction(async (tx) => {
    const values = decided.flatMap((d) =>
      GATES.filter((g) => g !== 'G4' || !d.hasLiveG4).map((g) => ({
        proposalId: d.proposalId,
        gate: g,
        outcome: d.decisions[g].outcome,
        ruleHits: d.decisions[g].hits,
        gateVersion: GATE_VERSION,
      })),
    );
    for (let i = 0; i < values.length; i += 500) {
      await tx
        .insert(gateDecisions)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [gateDecisions.proposalId, gateDecisions.gate],
          set: {
            outcome: sql`excluded.outcome`,
            ruleHits: sql`excluded.rule_hits`,
            gateVersion: sql`excluded.gate_version`,
            decidedAt: sql`now()`,
          },
        });
    }
    written = values.length;
  });
  return {
    proposals: decided.length,
    decisionsWritten: written,
    staticCapCents: cap.cents,
    staticCapSource: cap.source,
  };
}
