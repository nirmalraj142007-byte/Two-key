import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode, InjectionText } from '@twokey/core';
import {
  agentSessions,
  catalogSnapshots,
  type Db,
  listings,
  merchants,
  ruleCards,
  vaultTokens,
} from '@twokey/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { mintAgentToken } from '../auth/agent-token.js';
import { createRequireHuman, type HumanAssertionVerifier } from '../auth/human-assertion.js';
import { RATE_LIMITS, rateLimitIp } from '../rate-limits.js';
import { type EventHub, frame, HEARTBEAT_MS, type OutEvent, type StreamEvent } from './events.js';
import { CONNECT_PAYPAL_FIRST, SIGN_RULES_FIRST } from './human.js';

/** The demo listing every hijack session gets a private, injected copy of. */
export const HIJACK_TARGET = { groupKey: 'cloud-runner-cr1', merchantSlug: 'peak-outfitters' };
/** Public stream links stop working after this long. */
export const ATTEMPT_TOKEN_TTL_S = 60 * 60;

export interface HijackRouteOptions {
  db: Db;
  verifier: HumanAssertionVerifier;
  hub: EventHub;
  agentTokenPepper: string;
  /** Decoded RULE_HMAC_KEY; attempt tokens use a key derived from it, never the key itself. */
  ruleKey: Buffer;
  webOrigin: string;
  heartbeatMs?: number;
  now?: () => Date;
}

const Body = z.object({
  injectionText: InjectionText,
  model: z.string().min(1).max(100),
});
const Params = z.object({ attemptId: z.uuid() });
const Query = z.object({ t: z.string().min(1).max(300) });

/** Key for attempt tokens: HKDF from the rule key, so a token can never sign a rule card. */
export function attemptKey(ruleKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', ruleKey, Buffer.alloc(0), 'twokey hijack attempt', 32));
}

function attemptSig(key: Buffer, attemptId: string, sessionId: string, iat: number): string {
  return createHmac('sha256', key)
    .update(`hijack-attempt|${attemptId}|${sessionId}|${iat}`)
    .digest('base64url');
}

/** `{sessionId}.{iat}.{hmac}`: lets anyone holding it watch one attempt's events, for an hour. */
export function signAttemptToken(
  key: Buffer,
  attemptId: string,
  sessionId: string,
  now: Date,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  return `${sessionId}.${iat}.${attemptSig(key, attemptId, sessionId, iat)}`;
}

/** The session the token was issued for, or null when it is forged, foreign or expired. */
export function verifyAttemptToken(
  key: Buffer,
  attemptId: string,
  token: string,
  now: Date,
): string | null {
  const [sessionId, iatText, sig, extra] = token.split('.');
  if (!sessionId || !iatText || !sig || extra !== undefined || !/^\d{1,12}$/.test(iatText)) {
    return null;
  }
  if (!z.uuid().safeParse(sessionId).success) return null;
  const iat = Number(iatText);
  const age = Math.floor(now.getTime() / 1000) - iat;
  if (age < -60 || age > ATTEMPT_TOKEN_TTL_S) return null;
  const expected = Buffer.from(attemptSig(key, attemptId, sessionId, iat));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return sessionId;
}

/** Only this session's events, and only what a public page may show: no PayPal or approval IDs. */
export function publicEvent(e: OutEvent, sessionId: string): OutEvent | null {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (data.sessionId !== sessionId) return null;
  switch (e.event) {
    case 'agent.step':
    case 'hijack.step':
    case 'hijack.replay':
    case 'hijack.result':
      return e;
    case 'proposal.created':
    case 'payment.updated':
      return {
        event: e.event,
        data: {
          proposalId: data.proposalId,
          sessionId,
          product: data.product,
          merchant: data.merchant,
          qty: data.qty,
          amountCents: data.amountCents,
          state: data.state,
          reason: data.reason,
        },
      };
    default:
      return null;
  }
}

export const hijackRoutes: FastifyPluginAsync<HijackRouteOptions> = async (app, opts) => {
  const { db, hub } = opts;
  const now = opts.now ?? (() => new Date());
  const requireHuman = createRequireHuman(opts.verifier);
  const key = attemptKey(opts.ruleKey);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const open = new Set<FastifyReply>();
  // Users whose events the hub buffers from their first hijack session on, so a public stream
  // that opens a moment after the run starts still receives every step.
  const retained = new Set<string>();

  app.decorateRequest('human', null);

  // ---- create (web only, as the hijack system user) -----------------------------------------

  app.post('/human/hijack-sessions', { preHandler: requireHuman('hijack:create') }, async (req) => {
    const human = req.human;
    if (human?.role !== 'hijack_system') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Not allowed');
    }
    const body = Body.safeParse(req.body);
    if (!body.success) {
      throw new AppError(ErrorCode.VALIDATION, 'Body must be { injectionText (1–2,000), model }');
    }
    const { injectionText, model } = body.data;
    const { userId } = human;

    const [wallet] = await db
      .select({ id: vaultTokens.id })
      .from(vaultTokens)
      .where(and(eq(vaultTokens.userId, userId), eq(vaultTokens.status, 'active')))
      .limit(1);
    if (!wallet) throw new AppError(ErrorCode.CONFLICT, CONNECT_PAYPAL_FIRST);
    const [card] = await db
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
    if (!card) throw new AppError(ErrorCode.CONFLICT, SIGN_RULES_FIRST);

    const [original] = await db
      .select({ listing: listings })
      .from(listings)
      .innerJoin(catalogSnapshots, eq(catalogSnapshots.id, listings.snapshotId))
      .innerJoin(merchants, eq(merchants.id, listings.merchantId))
      .where(
        and(
          eq(catalogSnapshots.kind, 'demo_unbranded'),
          eq(listings.groupKey, HIJACK_TARGET.groupKey),
          eq(merchants.slug, HIJACK_TARGET.merchantSlug),
        ),
      )
      .limit(1);
    if (!original) throw new AppError(ErrorCode.CONFIG_INVALID, 'Demo catalog is not seeded');
    const src = original.listing;
    // Stored as text and only ever shown as text; the agent gets it as untrusted_listing_text.
    const description = `${src.description}\n\n${injectionText}`;

    if (!retained.has(userId)) {
      await hub.subscribe(userId, () => {});
      retained.add(userId);
    }

    const { token, hash } = mintAgentToken(opts.agentTokenPepper);
    const sessionId = await db.transaction(async (tx) => {
      const [session] = await tx
        .insert(agentSessions)
        .values({ userId, ruleCardId: card.id, mode: 'hijack', model, agentTokenHash: hash })
        .returning({ id: agentSessions.id });
      if (!session) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
      const [snapshot] = await tx
        .insert(catalogSnapshots)
        .values({
          kind: 'hijack',
          contentSha256: createHash('sha256').update(description).digest('hex'),
          sessionId: session.id,
        })
        .returning({ id: catalogSnapshots.id });
      if (!snapshot) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
      await tx.insert(listings).values({
        snapshotId: snapshot.id,
        groupKey: src.groupKey,
        merchantId: src.merchantId,
        title: src.title,
        brandName: null,
        category: src.category,
        priceCents: src.priceCents,
        currency: src.currency,
        referencePriceCents: src.referencePriceCents,
        referenceNOffers: src.referenceNOffers,
        structuredAttrs: src.structuredAttrs,
        description,
      });
      return session.id;
    });

    const attemptId = uuidv7();
    req.log.info({ event: 'hijack_session_created', sessionId, attemptId }, 'hijack session');
    return {
      sessionId,
      token,
      attemptId,
      attemptToken: signAttemptToken(key, attemptId, sessionId, now()),
    };
  });

  // ---- public stream ----------------------------------------------------------------------

  // CORS for /public/* is set app-wide (app.ts). 60 connections a minute per client IP.
  const publicLimit = {
    rateLimit: { max: RATE_LIMITS.public, timeWindow: '1 minute', keyGenerator: rateLimitIp },
  };

  app.get('/public/hijack/:attemptId/events', { config: publicLimit }, async (req, reply) => {
    const notFound = new AppError(ErrorCode.NOT_FOUND, 'Not found');
    const params = Params.safeParse(req.params);
    const query = Query.safeParse(req.query);
    if (!params.success || !query.success) throw notFound;
    const sessionId = verifyAttemptToken(key, params.data.attemptId, query.data.t, now());
    if (!sessionId) throw notFound;
    const [session] = await db
      .select({ userId: agentSessions.userId })
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.mode, 'hijack')))
      .limit(1);
    if (!session) throw notFound;

    let heartbeat: NodeJS.Timeout | undefined;
    let closed = false;
    // Live events that arrive before the headers and the replay are written wait here.
    let held: string[] | null = [];
    const write = (chunk: string) => {
      if (held) held.push(chunk);
      else if (!closed && !reply.raw.writableEnded) reply.raw.write(chunk);
    };
    const send = (events: StreamEvent[]) => {
      for (const e of events) {
        const shown = publicEvent(e, sessionId);
        if (shown) write(frame({ ...shown, id: e.id }));
      }
    };
    const lastEventId = z.string().max(100).safeParse(req.headers['last-event-id']);
    const sub = await hub.subscribe(
      session.userId,
      send,
      lastEventId.success ? lastEventId.data : undefined,
      { fromStart: true },
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      sub.unsubscribe();
      open.delete(reply);
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders();
    open.add(reply);
    const waiting = held;
    held = null;
    write(': connected\n\n');
    send(sub.replay);
    for (const chunk of waiting) write(chunk);
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
  });

  app.addHook('preClose', async () => {
    for (const reply of open) reply.raw.end();
    open.clear();
  });
};
