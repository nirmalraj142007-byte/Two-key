import { AppError, ErrorCode } from '@twokey/core';
import {
  attackTemplates,
  catalogSnapshots,
  type Db,
  evalEpisodeListings,
  evalEpisodes,
  evalRuns,
  evalTasks,
  listings,
  merchants,
} from '@twokey/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Dataset } from './dataset.js';
import { ATTACKER_SLUG } from './snapshot.js';
import { stableUuid } from './util.js';

export const SNAPSHOT_KEY = 'eval-build';
export const SNAPSHOT_ID = stableUuid('snapshot:eval_frozen');
const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Throws CONFLICT if the build would change, or drop, an episode that already carries a
 * frozen_tag. Runs before any write.
 */
export async function assertFrozenUnchanged(db: Db, data: Dataset): Promise<number> {
  const frozen = await db
    .select({ id: evalEpisodes.id, sha: evalEpisodes.contentSha256, tag: evalEpisodes.frozenTag })
    .from(evalEpisodes)
    .where(isNotNull(evalEpisodes.frozenTag));
  const next = new Map(data.episodes.map((e) => [e.id, e.contentSha256]));
  const changed = frozen.filter((f) => next.get(f.id) !== f.sha);
  if (changed.length > 0) {
    throw new AppError(
      ErrorCode.CONFLICT,
      `Refusing to change ${changed.length} frozen episode(s) (tag ${changed[0]?.tag}); first: ${changed[0]?.id}`,
    );
  }
  return frozen.length;
}

export async function persistDataset(db: Db, data: Dataset): Promise<{ frozenKept: number }> {
  const frozenKept = await assertFrozenUnchanged(db, data);

  await db.transaction(async (tx) => {
    const [attacker] = await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(and(eq(merchants.slug, ATTACKER_SLUG), eq(merchants.role, 'attacker')));
    if (!attacker) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID,
        'The GiftVault attacker merchant is missing. Run: npm run db:seed',
      );
    }

    await tx
      .insert(catalogSnapshots)
      .values({
        id: SNAPSHOT_ID,
        kind: 'eval_frozen',
        contentSha256: data.snapshotSha256,
        gitTag: SNAPSHOT_KEY,
      })
      .onConflictDoUpdate({
        target: catalogSnapshots.id,
        set: { contentSha256: data.snapshotSha256 },
      });

    const evalMerchants = data.merchants.filter((m) => m.role === 'eval_merchant');
    for (const part of chunks(evalMerchants)) {
      await tx
        .insert(merchants)
        .values(
          part.map((m) => ({ id: m.id, slug: m.slug, displayName: m.displayName, role: m.role })),
        )
        .onConflictDoNothing({ target: merchants.slug });
    }
    const slugToId = new Map<string, string>([[ATTACKER_SLUG, attacker.id]]);
    if (evalMerchants.length > 0) {
      const rows = await tx
        .select({ id: merchants.id, slug: merchants.slug, role: merchants.role })
        .from(merchants)
        .where(
          inArray(
            merchants.slug,
            evalMerchants.map((m) => m.slug),
          ),
        );
      for (const r of rows) slugToId.set(r.slug, r.id);
      for (const m of evalMerchants) {
        const row = rows.find((r) => r.slug === m.slug);
        if (!row || row.id !== m.id || row.role !== 'eval_merchant') {
          throw new AppError(
            ErrorCode.CONFLICT,
            `Merchant ${m.slug} exists with another id or role`,
          );
        }
      }
    }

    for (const part of chunks(data.listings)) {
      await tx
        .insert(listings)
        .values(
          part.map((l) => ({
            id: l.id,
            snapshotId: SNAPSHOT_ID,
            channel3ProductId: l.channel3ProductId,
            groupKey: l.groupKey,
            merchantId: slugToId.get(l.merchantSlug) as string,
            title: l.title,
            brandName: l.brandName,
            category: l.category,
            priceCents: l.priceCents,
            referencePriceCents: l.referencePriceCents,
            referenceNOffers: l.referenceNOffers,
            structuredAttrs: l.structuredAttrs,
            description: l.description,
            injectionId: l.injectionId,
          })),
        )
        .onConflictDoUpdate({
          target: [listings.snapshotId, listings.groupKey, listings.merchantId],
          set: {
            title: sql`excluded.title`,
            brandName: sql`excluded.brand_name`,
            category: sql`excluded.category`,
            priceCents: sql`excluded.price_cents`,
            referencePriceCents: sql`excluded.reference_price_cents`,
            referenceNOffers: sql`excluded.reference_n_offers`,
            structuredAttrs: sql`excluded.structured_attrs`,
            description: sql`excluded.description`,
            injectionId: sql`excluded.injection_id`,
          },
        });
    }

    // Drop tasks and episodes from an earlier, different build (never frozen ones, never ones with runs).
    const keepTasks = new Set(data.tasks.map((t) => t.id));
    const existingTasks = await tx.select({ id: evalTasks.id }).from(evalTasks);
    const stale = existingTasks.map((t) => t.id).filter((id) => !keepTasks.has(id));
    if (stale.length > 0) {
      const staleEpisodes = await tx
        .select({ id: evalEpisodes.id })
        .from(evalEpisodes)
        .where(inArray(evalEpisodes.taskId, stale));
      const ids = staleEpisodes.map((e) => e.id);
      if (ids.length > 0) {
        const runs = await tx
          .select({ id: evalRuns.id })
          .from(evalRuns)
          .where(inArray(evalRuns.episodeId, ids))
          .limit(1);
        if (runs.length > 0) {
          throw new AppError(
            ErrorCode.CONFLICT,
            'Refusing to drop episodes that already have runs',
          );
        }
        await tx.delete(evalEpisodeListings).where(inArray(evalEpisodeListings.episodeId, ids));
        await tx.delete(evalEpisodes).where(inArray(evalEpisodes.id, ids));
      }
      await tx.delete(evalTasks).where(inArray(evalTasks.id, stale));
    }

    for (const part of chunks(data.tasks)) {
      await tx
        .insert(evalTasks)
        .values(
          part.map((t) => ({
            id: t.id,
            split: t.split,
            webshopInstructionId: t.webshopInstructionId,
            instructionText: t.instructionText,
            priceCapCents: t.priceCapCents,
            category: t.category,
            goalAttrs: t.goalAttrs,
            sampleSeed: t.sampleSeed,
          })),
        )
        .onConflictDoUpdate({
          target: evalTasks.id,
          set: {
            split: sql`excluded.split`,
            instructionText: sql`excluded.instruction_text`,
            priceCapCents: sql`excluded.price_cap_cents`,
            category: sql`excluded.category`,
            goalAttrs: sql`excluded.goal_attrs`,
            sampleSeed: sql`excluded.sample_seed`,
          },
        });
    }

    for (const part of chunks(data.templates)) {
      await tx
        .insert(attackTemplates)
        .values(
          part.map((t) => ({
            id: t.id,
            source: t.source,
            sourceRef: t.sourceRef,
            originalText: t.originalText,
            adaptedText: t.adaptedText,
            diff: t.diff,
            licence: t.licence,
          })),
        )
        .onConflictDoUpdate({
          target: [attackTemplates.source, attackTemplates.sourceRef],
          set: {
            originalText: sql`excluded.original_text`,
            adaptedText: sql`excluded.adapted_text`,
            diff: sql`excluded.diff`,
            licence: sql`excluded.licence`,
          },
        });
    }

    for (const part of chunks(data.episodes)) {
      await tx
        .insert(evalEpisodes)
        .values(
          part.map((e) => ({
            id: e.id,
            taskId: e.taskId,
            variant: e.variant,
            attackTemplateId: e.attackTemplateId,
            targetType: e.targetType,
            targetListingId: e.targetListingId,
            injectedListingId: e.injectedListingId,
            injectionPosition: e.injectionPosition,
            targetFallback: e.targetFallback,
            contentSha256: e.contentSha256,
          })),
        )
        .onConflictDoUpdate({
          target: [evalEpisodes.taskId, evalEpisodes.variant],
          set: {
            attackTemplateId: sql`excluded.attack_template_id`,
            targetType: sql`excluded.target_type`,
            targetListingId: sql`excluded.target_listing_id`,
            injectedListingId: sql`excluded.injected_listing_id`,
            injectionPosition: sql`excluded.injection_position`,
            targetFallback: sql`excluded.target_fallback`,
            contentSha256: sql`excluded.content_sha256`,
          },
        });
    }

    const episodeIds = data.episodes.map((e) => e.id);
    for (const part of chunks(episodeIds)) {
      await tx.delete(evalEpisodeListings).where(inArray(evalEpisodeListings.episodeId, part));
    }
    const rows = data.episodes.flatMap((e) =>
      e.listingIds.map((listingId, position) => ({ episodeId: e.id, listingId, position })),
    );
    for (const part of chunks(rows)) await tx.insert(evalEpisodeListings).values(part);
  });

  return { frozenKept };
}
