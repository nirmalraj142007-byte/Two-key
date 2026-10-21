import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, fingerprint, RuleCardSchema, signCard } from '@twokey/core';
import { agentSessions, type Db, ruleCards, vaultTokens } from '@twokey/db';
import type { VaultApi } from '@twokey/paypal';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { mintAgentToken } from '../auth/agent-token.js';
import {
  createRequireHuman,
  type Human,
  type HumanAssertionVerifier,
} from '../auth/human-assertion.js';
import type { RuleKeys } from '../services/keys.js';

export interface HumanRouteOptions {
  db: Db;
  vault: Pick<VaultApi, 'createSetupToken' | 'createPaymentToken' | 'deletePaymentToken'>;
  verifier: HumanAssertionVerifier;
  keys: RuleKeys;
  /** The key new cards are signed with: RULE_HMAC_KEY_ID. */
  signingKeyId: string;
  agentTokenPepper: string;
  webOrigin: string;
  now?: () => Date;
}

export const CONNECT_PAYPAL_FIRST = 'Connect PayPal first';
export const SIGN_RULES_FIRST = 'Sign your rules first';

/** Setup tokens wait here between creation and approval (PayPal lets them live for hours). */
const SETUP_TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

const IdParams = z.object({ id: z.uuid() });
const SetupTokenBody = z.object({ returnUrl: z.string().min(1).max(2000) });
const PaymentTokenBody = z.object({ setupTokenId: z.string().min(1).max(100) });
const SessionBody = z.object({
  mode: z.enum(['live', 'demo']),
  model: z.string().min(1).max(100),
});

function humanOf(req: FastifyRequest): Human {
  if (!req.human) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in again');
  return req.human;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(ErrorCode.VALIDATION, message);
  return result.data;
}

function notFound(what: string): AppError {
  return new AppError(ErrorCode.NOT_FOUND, `${what} not found`);
}

/** An unknown or foreign rule card ID is the same 404 as a missing one. */
function cardId(req: FastifyRequest): string {
  const params = IdParams.safeParse(req.params);
  if (!params.success) throw notFound('Rule card');
  return params.data.id;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export const humanRoutes: FastifyPluginAsync<HumanRouteOptions> = async (app, opts) => {
  const { db, vault } = opts;
  const now = opts.now ?? (() => new Date());
  const requireHuman = createRequireHuman(opts.verifier);
  const signingSecret = opts.keys[opts.signingKeyId];
  if (!signingSecret) throw new Error('signing key is not in the key map');
  // userId -> the setup token created for that user. Single gateway instance (see
  // human-assertion.ts); a restart only means the user starts onboarding again.
  const pendingSetupTokens = new LRUCache<string, string>({
    max: 10_000,
    ttl: SETUP_TOKEN_TTL_MS,
  });

  app.decorateRequest('human', null);

  async function activeVaultToken(userId: string) {
    const [row] = await db
      .select({ id: vaultTokens.id, paymentTokenId: vaultTokens.paymentTokenId })
      .from(vaultTokens)
      .where(and(eq(vaultTokens.userId, userId), eq(vaultTokens.status, 'active')))
      .limit(1);
    return row;
  }

  async function activeCard(userId: string) {
    const [row] = await db
      .select({ id: ruleCards.id })
      .from(ruleCards)
      .where(
        and(
          eq(ruleCards.userId, userId),
          eq(ruleCards.status, 'signed'),
          gt(ruleCards.expiresAt, now()),
        ),
      )
      .orderBy(desc(ruleCards.version))
      .limit(1);
    return row;
  }

  app.get('/human/me', { preHandler: requireHuman() }, async (req) => {
    const { userId, role } = humanOf(req);
    const [token, card] = await Promise.all([activeVaultToken(userId), activeCard(userId)]);
    return { userId, role, vaultConnected: token !== undefined, activeCardId: card?.id ?? null };
  });

  // ---- vault -------------------------------------------------------------------------------

  app.post(
    '/human/vault/setup-token',
    { preHandler: requireHuman('vault:manage') },
    async (req) => {
      const { userId } = humanOf(req);
      const { returnUrl } = parse(SetupTokenBody, req.body, 'Body must be { returnUrl }');
      if (!sameOrigin(returnUrl, opts.webOrigin)) {
        throw new AppError(ErrorCode.VALIDATION, 'returnUrl must be on the web app');
      }
      const cancel = new URL(returnUrl);
      cancel.searchParams.set('cancelled', '1');
      const token = await vault.createSetupToken({
        returnUrl,
        cancelUrl: cancel.toString(),
        requestId: `tk-setup-${randomUUID()}`,
      });
      pendingSetupTokens.set(userId, token.id);
      return { setupTokenId: token.id, approveUrl: token.approveUrl };
    },
  );

  app.post(
    '/human/vault/payment-token',
    { preHandler: requireHuman('vault:manage') },
    async (req) => {
      const { userId } = humanOf(req);
      const { setupTokenId } = parse(PaymentTokenBody, req.body, 'Body must be { setupTokenId }');
      // Only the setup token created for this user, in this onboarding: a stale or foreign
      // approval is rejected before PayPal is asked to turn it into a payment token.
      if (pendingSetupTokens.get(userId) !== setupTokenId) throw notFound('Setup token');

      const created = await vault.createPaymentToken({
        setupTokenId,
        requestId: `tk-vault-${setupTokenId}`,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(vaultTokens)
          .set({ status: 'deleted', deletedAt: now() })
          .where(and(eq(vaultTokens.userId, userId), eq(vaultTokens.status, 'active')));
        await tx.insert(vaultTokens).values({
          userId,
          paypalCustomerId: created.customerId,
          paymentTokenId: created.paymentTokenId,
          status: 'active',
        });
      });
      pendingSetupTokens.delete(userId);
      req.log.info({ event: 'vault_connected' }, 'vault connected');
      return { connected: true };
    },
  );

  app.delete('/human/vault', { preHandler: requireHuman('vault:manage') }, async (req) => {
    const { userId, role } = humanOf(req);
    if (role === 'judge_demo') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Demo accounts keep their PayPal wallet');
    }
    const token = await activeVaultToken(userId);
    if (!token) throw notFound('PayPal wallet');
    await vault.deletePaymentToken(token.paymentTokenId);
    await db
      .update(vaultTokens)
      .set({ status: 'deleted', deletedAt: now() })
      .where(and(eq(vaultTokens.id, token.id), eq(vaultTokens.userId, userId)));
    return { connected: false };
  });

  // ---- rules -------------------------------------------------------------------------------

  app.post('/human/rules/:id/sign', { preHandler: requireHuman('rules:sign') }, async (req) => {
    const { userId } = humanOf(req);
    const id = cardId(req);
    const signedAt = now();

    return db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(ruleCards)
        .where(and(eq(ruleCards.id, id), eq(ruleCards.userId, userId)))
        .for('update')
        .limit(1);
      if (!draft) throw notFound('Rule card');
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
        const paths = [
          ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(card)')),
        ].join(', ');
        throw new AppError(ErrorCode.RULE_CARD_INVALID, `Rule card is invalid: ${paths}`);
      }
      const card = parsed.data;
      const expiresAt = new Date(card.expiresAt);
      if (expiresAt.getTime() <= signedAt.getTime()) {
        throw new AppError(ErrorCode.RULE_CARD_INVALID, 'Rule card is invalid: expiresAt');
      }

      const signed = signCard(card, { id: opts.signingKeyId, secret: signingSecret });
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
          signedAt,
          expiresAt,
        })
        .where(and(eq(ruleCards.id, id), eq(ruleCards.userId, userId)));
      return { id, version, fingerprint: fingerprint(signed) };
    });
  });

  app.post('/human/rules/:id/revoke', { preHandler: requireHuman('rules:sign') }, async (req) => {
    const { userId } = humanOf(req);
    const id = cardId(req);
    const [row] = await db
      .select({ status: ruleCards.status })
      .from(ruleCards)
      .where(and(eq(ruleCards.id, id), eq(ruleCards.userId, userId)))
      .limit(1);
    if (!row) throw notFound('Rule card');
    if (row.status !== 'signed') {
      throw new AppError(ErrorCode.CONFLICT, 'Only signed rules can be revoked');
    }
    await db
      .update(ruleCards)
      .set({ status: 'revoked' })
      .where(and(eq(ruleCards.id, id), eq(ruleCards.userId, userId)));
    return { id, status: 'revoked' };
  });

  // ---- sessions ----------------------------------------------------------------------------

  app.post('/human/sessions', { preHandler: requireHuman('sessions:create') }, async (req) => {
    const { userId } = humanOf(req);
    const body = parse(SessionBody, req.body, "Body must be { mode: 'live' | 'demo', model }");
    if (!(await activeVaultToken(userId))) {
      throw new AppError(ErrorCode.CONFLICT, CONNECT_PAYPAL_FIRST);
    }
    const card = await activeCard(userId);
    if (!card) throw new AppError(ErrorCode.CONFLICT, SIGN_RULES_FIRST);

    // The token is returned once, here; only its hash is stored.
    const { token, hash } = mintAgentToken(opts.agentTokenPepper);
    const [session] = await db
      .insert(agentSessions)
      .values({
        userId,
        ruleCardId: card.id,
        mode: body.mode,
        model: body.model,
        agentTokenHash: hash,
      })
      .returning({ id: agentSessions.id });
    if (!session) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
    return { sessionId: session.id, token };
  });
};
