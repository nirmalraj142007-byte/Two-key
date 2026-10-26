import { AppError, ErrorCode, type PaymentState } from '@twokey/core';
import {
  agentSessions,
  approvals,
  type Db,
  listings,
  merchants,
  payments,
  proposals,
} from '@twokey/db';
import { and, desc, eq, ne, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';
import postgres from 'postgres';
import { z } from 'zod';
import {
  createRequireHuman,
  type Human,
  type HumanAssertionVerifier,
} from '../auth/human-assertion.js';
import { loadProposalResult } from '../services/purchase.js';
import { NOTIFY_CHANNEL } from '../services/webhook-apply.js';

// ---------------------------------------------------------------------------------------------
// What a browser may see. Built from rows filtered by the subscriber's user; never carries vault
// or payment-token IDs, agent tokens or raw webhook bodies.

export type CardState = PaymentState | 'blocked' | 'recorded';

export interface ProposalView {
  proposalId: string;
  sessionId: string;
  createdAt: string;
  product: string;
  merchant: string;
  qty: number;
  amountCents: number;
  /** Payment state, or 'blocked' when the rules stopped it before PayPal. */
  state: CardState;
  /** The gateway's own sentence for this outcome. */
  reason: string;
  paymentId: string | null;
  orderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  /** Vaulted payments are authorized with nobody at the PayPal checkout. */
  buyerPresent: boolean;
  approvalId: string | null;
  holdDeadlineAt: string | null;
}

export interface ApprovalView {
  approvalId: string;
  proposalId: string;
  paymentId: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  deadlineAt: string;
  decidedAt: string | null;
  decidedVia: 'web' | 'phone' | null;
}

export type EventName =
  | 'agent.step'
  | 'proposal.created'
  | 'payment.updated'
  | 'approval.created'
  | 'approval.decided';

export interface OutEvent {
  event: EventName;
  data: unknown;
}

const AUTHORIZING_REASON = 'PayPal is authorizing this purchase on your saved wallet.';

function proposalQuery(db: Db, userId: string, where: SQL | undefined) {
  return db
    .select({
      proposalId: proposals.id,
      sessionId: proposals.sessionId,
      createdAt: proposals.createdAt,
      product: listings.title,
      merchant: merchants.displayName,
      qty: proposals.qty,
      amountCents: proposals.resolvedAmountCents,
      paymentId: payments.id,
      state: payments.state,
      orderId: payments.paypalOrderId,
      authorizationId: payments.paypalAuthorizationId,
      captureId: payments.paypalCaptureId,
      holdDeadlineAt: payments.holdDeadlineAt,
      approvalId: approvals.id,
    })
    .from(proposals)
    .innerJoin(agentSessions, eq(agentSessions.id, proposals.sessionId))
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
    .leftJoin(payments, eq(payments.proposalId, proposals.id))
    .leftJoin(approvals, eq(approvals.paymentId, payments.id))
    .where(and(eq(agentSessions.userId, userId), ne(agentSessions.mode, 'eval'), where));
}

type ProposalRow = Awaited<ReturnType<typeof proposalQuery>>[number];

async function toView(db: Db, row: ProposalRow): Promise<ProposalView> {
  let reason: string;
  let blocked = false;
  let recorded = false;
  try {
    const result = await loadProposalResult(db, row.proposalId);
    reason = result.reason;
    blocked = result.decision === 'blocked';
    recorded = result.decision === 'recorded';
  } catch (err) {
    // authorizing/authorized: the purchase is still in flight.
    if (err instanceof AppError && err.code === ErrorCode.CONFLICT) reason = AUTHORIZING_REASON;
    else throw err;
  }
  return {
    proposalId: row.proposalId,
    sessionId: row.sessionId,
    createdAt: row.createdAt.toISOString(),
    product: row.product,
    merchant: row.merchant,
    qty: row.qty,
    amountCents: row.amountCents,
    state: blocked ? 'blocked' : (row.state ?? (recorded ? 'recorded' : 'failed')),
    reason,
    paymentId: row.paymentId,
    orderId: row.orderId,
    authorizationId: row.authorizationId,
    captureId: row.captureId,
    buyerPresent: false,
    approvalId: row.approvalId,
    holdDeadlineAt: row.holdDeadlineAt?.toISOString() ?? null,
  };
}

/** The user's most recent proposals (eval sessions excluded), newest first. */
export async function recentProposals(db: Db, userId: string, limit = 10) {
  const rows = await proposalQuery(db, userId, undefined)
    .orderBy(desc(proposals.createdAt))
    .limit(limit);
  return Promise.all(rows.map((r) => toView(db, r)));
}

async function proposalView(db: Db, userId: string, where: SQL) {
  const [row] = await proposalQuery(db, userId, where).limit(1);
  return row ? toView(db, row) : undefined;
}

async function approvalView(db: Db, userId: string, paymentId: string) {
  const [row] = await db
    .select({
      approvalId: approvals.id,
      proposalId: payments.proposalId,
      paymentId: approvals.paymentId,
      status: approvals.status,
      deadlineAt: approvals.deadlineAt,
      decidedAt: approvals.decidedAt,
      decidedVia: approvals.decidedVia,
    })
    .from(approvals)
    .innerJoin(payments, eq(payments.id, approvals.paymentId))
    .where(and(eq(approvals.paymentId, paymentId), eq(approvals.userId, userId)))
    .limit(1);
  if (!row) return undefined;
  return {
    ...row,
    deadlineAt: row.deadlineAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  } satisfies ApprovalView;
}

// ---------------------------------------------------------------------------------------------
// Notifications in, events out

const Notice = z.object({
  type: z.string(),
  userId: z.uuid(),
  sessionId: z.string().optional(),
  proposalId: z.string().optional(),
  paymentId: z.string().optional(),
  entry: z.unknown().optional(),
});

/** Only the fields the console shows; anything else the runner adds is dropped. */
const StepEntry = z.object({
  turn: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool', 'error']),
  text: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })).optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  at: z.string(),
});

const IdLike = z.uuid();
const DECIDED_STATES = new Set<PaymentState>([
  'capture_requested',
  'captured',
  'void_requested',
  'voided',
  'expired',
  'denied',
]);

/** Turns one twokey_events notification into the events its owner should see. */
export async function expandNotice(
  db: Db,
  notice: z.infer<typeof Notice>,
  sentDecisions: LRUCache<string, true>,
): Promise<OutEvent[]> {
  const { userId } = notice;
  switch (notice.type) {
    case 'agent.step': {
      const entry = StepEntry.safeParse(notice.entry);
      if (!entry.success || !notice.sessionId) return [];
      return [{ event: 'agent.step', data: { sessionId: notice.sessionId, entry: entry.data } }];
    }
    case 'proposal.created': {
      const id = IdLike.safeParse(notice.proposalId);
      if (!id.success) return [];
      const view = await proposalView(db, userId, eq(proposals.id, id.data));
      return view ? [{ event: 'proposal.created', data: view }] : [];
    }
    case 'payment.updated': {
      const id = IdLike.safeParse(notice.paymentId);
      if (!id.success) return [];
      const view = await proposalView(db, userId, eq(payments.id, id.data));
      if (!view) return [];
      const out: OutEvent[] = [{ event: 'payment.updated', data: view }];
      const approval = await approvalView(db, userId, id.data);
      if (approval?.status === 'pending' && view.state === 'held') {
        out.push({ event: 'approval.created', data: approval });
      } else if (
        approval &&
        approval.status !== 'pending' &&
        DECIDED_STATES.has(view.state as PaymentState) &&
        !sentDecisions.has(approval.approvalId)
      ) {
        sentDecisions.set(approval.approvalId, true);
        out.push({ event: 'approval.decided', data: approval });
      }
      return out;
    }
    default:
      return [];
  }
}

type Send = (events: OutEvent[]) => void;

export interface EventHub {
  subscribe(userId: string, send: Send): Promise<() => void>;
  subscriberCount(): number;
  close(): Promise<void>;
}

/**
 * One LISTEN connection for the whole gateway, opened with the first subscriber. Notifications
 * are handled one at a time so a user's events arrive in the order they were committed.
 */
export function createEventHub(databaseUrl: string, db: Db, log: FastifyBaseLogger): EventHub {
  const subs = new Map<string, Set<Send>>();
  const sentDecisions = new LRUCache<string, true>({ max: 10_000 });
  let sql: postgres.Sql | undefined;
  let listening: Promise<unknown> | undefined;
  let queue: Promise<void> = Promise.resolve();

  async function handle(payload: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const notice = Notice.safeParse(raw);
    if (!notice.success) return;
    const targets = subs.get(notice.data.userId);
    if (!targets || targets.size === 0) return;
    const events = await expandNotice(db, notice.data, sentDecisions);
    if (events.length === 0) return;
    for (const send of targets) send(events);
  }

  function listen(): Promise<unknown> {
    sql ??= postgres(databaseUrl, { max: 1, onnotice: () => {} });
    listening ??= sql
      .listen(NOTIFY_CHANNEL, (payload) => {
        queue = queue
          .then(() => handle(payload))
          .catch((err) => log.error({ err }, 'event fan-out failed'));
      })
      .catch((err) => {
        listening = undefined;
        throw err;
      });
    return listening;
  }

  return {
    async subscribe(userId, send) {
      await listen();
      let set = subs.get(userId);
      if (!set) {
        set = new Set();
        subs.set(userId, set);
      }
      set.add(send);
      return () => {
        set.delete(send);
        if (set.size === 0) subs.delete(userId);
      };
    },
    subscriberCount() {
      let n = 0;
      for (const set of subs.values()) n += set.size;
      return n;
    },
    async close() {
      subs.clear();
      await sql?.end({ timeout: 5 });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Routes

export interface EventRouteOptions {
  db: Db;
  databaseUrl: string;
  verifier: HumanAssertionVerifier;
  webOrigin: string;
  heartbeatMs?: number;
  /** Replaces the LISTEN hub (tests). */
  hub?: EventHub;
}

const HEARTBEAT_MS = 15_000;
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

function humanOf(req: FastifyRequest): Human {
  if (!req.human) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in again');
  return req.human;
}

function frame(e: OutEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

export const eventRoutes: FastifyPluginAsync<EventRouteOptions> = async (app, opts) => {
  const { db } = opts;
  const requireHuman = createRequireHuman(opts.verifier);
  const hub = opts.hub ?? createEventHub(opts.databaseUrl, db, app.log);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const open = new Set<FastifyReply>();
  const origin = new URL(opts.webOrigin).origin;

  app.decorateRequest('human', null);

  // CORS for the web app's browser (no cookies: the bearer assertion is the credential). Set on
  // every response here, errors included, so the browser can read a 401 and mint a new one.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'origin');
  });
  app.options('/human/events', async (_req, reply) => {
    reply
      .header('access-control-allow-methods', 'GET')
      .header('access-control-allow-headers', 'authorization, last-event-id, cache-control')
      .header('access-control-max-age', '600');
    return reply.status(204).send();
  });

  app.get('/human/proposals', { preHandler: requireHuman('events:read') }, async (req) => {
    const { userId } = humanOf(req);
    const query = ListQuery.safeParse(req.query);
    if (!query.success) throw new AppError(ErrorCode.VALIDATION, 'limit must be 1 to 50');
    return { items: await recentProposals(db, userId, query.data.limit) };
  });

  app.get('/human/events', { preHandler: requireHuman('events:read') }, async (req, reply) => {
    const { userId } = humanOf(req);
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      open.delete(reply);
    };

    const write = (chunk: string) => {
      if (!closed && !reply.raw.writableEnded) reply.raw.write(chunk);
    };
    // Subscribe before the headers go out: a hub failure is still an ordinary error response.
    unsubscribe = await hub.subscribe(userId, (events) => {
      for (const e of events) write(frame(e));
    });

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
    write(': connected\n\n');
    heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
    req.log.info({ subscribers: hub.subscriberCount() }, 'events stream opened');
  });

  // Open streams never go idle; end them so the server can close.
  app.addHook('preClose', async () => {
    for (const reply of open) reply.raw.end();
    open.clear();
  });
  app.addHook('onClose', async () => {
    if (!opts.hub) await hub.close();
  });
};
