import { AppError, ErrorCode, fingerprint, RuleCardSchema, signCard } from '@twokey/core';
import { type Db, ruleCards } from '@twokey/db';
import { and, eq } from 'drizzle-orm';

export interface SignDraftInput {
  userId: string;
  draftId: string;
  signingKeyId: string;
  signingSecret: Buffer;
  now: Date;
}

/**
 * Signs one stored draft for its owner and revokes the owner's previous signed card, in one
 * transaction. The only signer: POST /human/rules/:id/sign and the demo scripts (demo:setup,
 * demo:reset, which run with the gateway's own secrets) both call it.
 */
export async function signDraftCard(
  db: Db,
  { userId, draftId, signingKeyId, signingSecret, now }: SignDraftInput,
): Promise<{ id: string; version: number; fingerprint: string }> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(ruleCards)
      .where(and(eq(ruleCards.id, draftId), eq(ruleCards.userId, userId)))
      .for('update')
      .limit(1);
    if (!draft) throw new AppError(ErrorCode.NOT_FOUND, 'Rule card not found');
    if (draft.status !== 'draft') {
      throw new AppError(ErrorCode.CONFLICT, 'Only draft rules can be signed');
    }

    // The compiler assigned the version when it created the draft; signing keeps it.
    const { version } = draft;

    // The asserted user is the only possible owner, whatever the draft says.
    const draftRules =
      typeof draft.rules === 'object' && draft.rules !== null && !Array.isArray(draft.rules)
        ? draft.rules
        : {};
    const parsed = RuleCardSchema.safeParse({ ...draftRules, userId, version });
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(card)'))].join(
        ', ',
      );
      throw new AppError(ErrorCode.RULE_CARD_INVALID, `Rule card is invalid: ${paths}`);
    }
    const card = parsed.data;
    const expiresAt = new Date(card.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) {
      throw new AppError(ErrorCode.RULE_CARD_INVALID, 'Rule card is invalid: expiresAt');
    }

    const signed = signCard(card, { id: signingKeyId, secret: signingSecret });
    await tx
      .update(ruleCards)
      .set({ status: 'revoked' })
      .where(and(eq(ruleCards.userId, userId), eq(ruleCards.status, 'signed')));
    await tx
      .update(ruleCards)
      .set({
        version,
        status: 'signed',
        rules: signed.card,
        hmac: signed.sig,
        keyId: signed.keyId,
        signedAt: now,
        expiresAt,
      })
      .where(and(eq(ruleCards.id, draftId), eq(ruleCards.userId, userId)));
    return { id: draftId, version, fingerprint: fingerprint(signed) };
  });
}
