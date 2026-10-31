import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  AppError,
  createLogger,
  type Env,
  ErrorCode,
  enterLogContext,
  type LogContext,
  requestIdFrom,
  toHttp,
} from '@twokey/core';
import { payments } from '@twokey/db';
import {
  createMerchantPayPal,
  type MerchantPayPalLookup,
  type OrdersApi,
  type VaultApi,
  type VerifyWebhookSignature,
} from '@twokey/paypal';
import { count, inArray, sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { createHumanAssertionVerifier } from './auth/human-assertion.js';
import { createJobRunner } from './jobs/boss.js';
import type { Jobs } from './jobs/queue.js';
import { OPEN_STATES } from './jobs/sweep.js';
import { openAuthorizations, recordPayPalCall } from './metrics.js';
import { dbPlugin } from './plugins/db.js';
import { agentRoutes } from './routes/agent.js';
import { createEventHub, eventRoutes } from './routes/events.js';
import { type HealthPayPal, healthRoutes } from './routes/health.js';
import { hijackRoutes } from './routes/hijack.js';
import { humanRoutes } from './routes/human.js';
import { humanApprovalRoutes } from './routes/human-approvals.js';
import { internalEvalRoutes } from './routes/internal-eval.js';
import { merchantRoutes } from './routes/merchants.js';
import { metricsRoutes } from './routes/metrics.js';
import { pushRoutes } from './routes/push.js';
import { webhookRoutes } from './routes/webhooks.js';
import { type BalanceService, createBalanceService } from './services/balances.js';
import { type Channel3Service, createChannel3Service } from './services/channel3.js';
import { loadRuleKeys } from './services/keys.js';
import { getPayPal } from './services/paypal.js';
import {
  createPushService,
  type PushService,
  type SendPush,
  webPushSender,
} from './services/push.js';

export type AppEnv = Pick<Env<'gateway'>, 'LOG_LEVEL'> &
  Partial<
    Pick<
      Env<'gateway'>,
      | 'NODE_ENV'
      | 'EVAL_ENABLED'
      | 'EVAL_ADMIN_TOKEN'
      | 'DATABASE_URL'
      | 'PAYPAL_WEBHOOK_ID'
      | 'PUBLIC_BASE_URL'
      | 'PAYPAL_ENV'
      | 'PAYPAL_CLIENT_ID'
      | 'PAYPAL_CLIENT_SECRET'
      | 'RULE_HMAC_KEY'
      | 'RULE_HMAC_KEY_ID'
      | 'AGENT_TOKEN_PEPPER'
      | 'CHANNEL3_API_KEY'
      | 'DEMO_HOLD_MINUTES'
      | 'HUMAN_ASSERTION_PUBLIC_KEY'
      | 'WEB_ORIGIN'
      | 'MERCHANT_API_CREDENTIALS'
      | 'VAPID_PUBLIC_KEY'
      | 'VAPID_PRIVATE_KEY'
      | 'VAPID_SUBJECT'
      | 'METRICS_TOKEN'
      | 'RENDER_SERVICE_NAME'
    >
  >;

export interface AppDeps {
  verifyWebhookSignature?: VerifyWebhookSignature;
  /** PayPal calls behind /healthz/deep. */
  paypalHealth?: HealthPayPal;
  /** Replaces the `select 1` DB check (tests). */
  checkDb?: () => Promise<void>;
  /** Replaces the webhook-lag query behind /healthz/paypal (tests). */
  webhookLagSince?: (since: Date) => Promise<boolean>;
  /** Replaces the process-wide PayPal client (tests). */
  paypal?: PayPalOps;
  /** Replaces the process-wide PayPal vault client (tests). */
  vault?: Pick<VaultApi, 'createSetupToken' | 'createPaymentToken' | 'deletePaymentToken'>;
  /** Replaces the per-merchant clients built from MERCHANT_API_CREDENTIALS (tests). */
  merchantPayPal?: MerchantPayPalLookup;
  /** Replaces the pg-boss job runner (tests record sends instead). */
  jobs?: Jobs;
  /** Replaces the Channel3 live search (tests). */
  channel3?: Channel3Service;
  /** Replaces the web-push sender (tests record pushes instead). */
  sendPush?: SendPush;
  /** Replaces the merchant balance service (tests). */
  balances?: BalanceService;
  /** SSE heartbeat interval on /human/events (tests shorten it). */
  eventsHeartbeatMs?: number;
  /** How often twokey_open_authorizations is refreshed (tests shorten it). */
  openAuthorizationsRefreshMs?: number;
  now?: () => Date;
}

export type PayPalOps = Pick<
  OrdersApi,
  'createVaultedAuthorization' | 'capture' | 'getAuthorization' | 'getCapture'
>;

/** Fastify's own 4xx errors (bad JSON, wrong content type, body too large). */
function isClientError(err: unknown): err is { statusCode: number } {
  const e = err as { code?: unknown; statusCode?: unknown };
  return (
    typeof e?.code === 'string' &&
    e.code.startsWith('FST_') &&
    typeof e.statusCode === 'number' &&
    e.statusCode >= 400 &&
    e.statusCode < 500
  );
}

/**
 * What a failed request logs. Database errors carry the SQL params (vault and payment-token
 * IDs among them), so only their type and the Postgres code and constraint are kept.
 */
export function safeErr(err: unknown): unknown {
  const e = err as { name?: unknown; query?: unknown; params?: unknown; cause?: unknown };
  if (!e || typeof e !== 'object' || !('query' in e || 'params' in e)) return err;
  const cause = (e.cause ?? {}) as { code?: unknown; constraint_name?: unknown };
  return {
    type: typeof e.name === 'string' ? e.name : 'DatabaseError',
    message: 'Database query failed',
    pgCode: typeof cause.code === 'string' ? cause.code : undefined,
    constraint: typeof cause.constraint_name === 'string' ? cause.constraint_name : undefined,
  };
}

/** Request bodies above this are refused with 413 (the largest real one, a webhook, is ~5 KB). */
export const BODY_LIMIT_BYTES = 64 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    logContext: LogContext;
  }
}

export function buildApp(env: AppEnv, deps: AppDeps = {}): FastifyInstance {
  // Evaluation session minting: only when explicitly enabled, never in production.
  if (
    env.EVAL_ENABLED &&
    (env.NODE_ENV === 'production' || env.RENDER_SERVICE_NAME?.endsWith('-prod'))
  ) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'EVAL_ENABLED must not be set in production');
  }

  const app = Fastify({
    loggerInstance: createLogger('gateway', env.LOG_LEVEL) as FastifyBaseLogger,
    // Keep the caller's x-request-id (web, MCP) when it is a UUID, so one ID follows a request.
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    bodyLimit: BODY_LIMIT_BYTES,
    // Render's proxy is the one trusted hop: req.ip is the rightmost x-forwarded-for entry,
    // the same key clientIp() picks for every rate limit.
    trustProxy: (_address, hop) => hop === 0,
  });

  // Every log line written while serving a request carries its requestId, and the user,
  // session, proposal and payment once known. Body parsing loses async context, so the same
  // context object is entered again before validation.
  app.decorateRequest('logContext', null as unknown as LogContext);
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    req.logContext = { requestId: req.id };
    enterLogContext(req.logContext, done);
  });
  app.addHook('preValidation', (req, _reply, done) => {
    enterLogContext(req.logContext, done);
  });

  app.register(helmet, {
    // A JSON and event-stream API: nothing here is ever rendered as a page.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  // The web app's browser calls /human/* (event stream) and /public/* (hijack stream) directly;
  // no other route answers cross-origin. No cookies: the bearer assertion is the credential.
  const webOrigin = env.WEB_ORIGIN ? new URL(env.WEB_ORIGIN).origin : undefined;
  app.register(cors, {
    hook: 'onRequest',
    strictPreflight: false,
    delegator: (req, cb) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const allowed = webOrigin && (path.startsWith('/human/') || path.startsWith('/public/'));
      cb(
        null,
        allowed
          ? {
              origin: webOrigin,
              methods: ['GET', 'POST', 'DELETE'],
              allowedHeaders: ['authorization', 'content-type', 'last-event-id', 'cache-control'],
              exposedHeaders: ['x-request-id'],
              maxAge: 600,
              strictPreflight: false,
            }
          : { origin: false },
      );
    },
  });
  // Limits are set per route (config.rateLimit); a 429 uses the standard error body.
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError(ErrorCode.RATE_LIMITED, 'Too many requests. Wait a minute and retry.', {
        details: { limit: ctx.max, retryAfterSeconds: Math.ceil(ctx.ttl / 1000) },
      }),
  });
  app.register(metricsRoutes, { token: env.METRICS_TOKEN });

  app.setErrorHandler((err, req, reply) => {
    const mapped = isClientError(err)
      ? new AppError(ErrorCode.VALIDATION, 'Invalid request', { httpStatus: err.statusCode })
      : err;
    const { status, body } = toHttp(mapped, req.id);
    if (status >= 500) req.log.error({ err: safeErr(err) }, 'request failed');
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const { status, body } = toHttp(new AppError(ErrorCode.NOT_FOUND, 'Not found'), req.id);
    return reply.status(status).send(body);
  });

  if (env.DATABASE_URL) app.register(dbPlugin, { url: env.DATABASE_URL });
  app.register(healthRoutes, {
    checkDb:
      deps.checkDb ??
      (env.DATABASE_URL
        ? async () => {
            await app.db.execute(sql`select 1`);
          }
        : undefined),
    paypal: deps.paypalHealth,
    webhookLagSince:
      deps.webhookLagSince ??
      (env.DATABASE_URL
        ? async (since: Date) => {
            // Payments waiting on a PayPal webhook since before `since`, and none received after.
            const at = since.toISOString();
            const rows = await app.db.execute<{ lagging: boolean }>(sql`
              select exists (
                select 1 from payments
                where state in ('authorizing', 'capture_requested', 'void_requested')
                  and updated_at < ${at}::timestamptz
              ) and not exists (
                select 1 from webhook_events where received_at >= ${at}::timestamptz
              ) as lagging`);
            return rows[0]?.lagging === true;
          }
        : undefined),
    webhookId: env.PAYPAL_WEBHOOK_ID,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  });
  // pg-boss connects lazily (first send, or startJobs on boot) and stops with the app.
  const runner = !deps.jobs && env.DATABASE_URL ? createJobRunner(env.DATABASE_URL, app.log) : null;
  const jobs: Jobs = deps.jobs ??
    runner ?? {
      send: async () => {
        throw new AppError(ErrorCode.CONFIG_INVALID, 'Jobs need DATABASE_URL');
      },
    };
  app.decorate('jobs', jobs);
  if (runner) app.addHook('onClose', () => runner.stop());

  // twokey_open_authorizations: one count query every 30 s while the app runs.
  if (env.DATABASE_URL) {
    let timer: NodeJS.Timeout | undefined;
    const refresh = async () => {
      try {
        const [row] = await app.db
          .select({ n: count() })
          .from(payments)
          .where(inArray(payments.state, OPEN_STATES));
        openAuthorizations.set(row?.n ?? 0);
      } catch (err) {
        app.log.warn({ err: safeErr(err) }, 'open authorizations gauge refresh failed');
      }
    };
    app.addHook('onReady', async () => {
      void refresh();
      timer = setInterval(refresh, deps.openAuthorizationsRefreshMs ?? 30_000);
      timer.unref();
    });
    app.addHook('onClose', async () => clearInterval(timer));
  }

  app.register(webhookRoutes, {
    webhookId: env.PAYPAL_WEBHOOK_ID,
    verify: deps.verifyWebhookSignature,
    jobs,
  });

  // Agent routes need the database, the rule key, the token pepper and PayPal; without all of
  // them they are not mounted (and answer 404).
  const { DATABASE_URL, RULE_HMAC_KEY, RULE_HMAC_KEY_ID, AGENT_TOKEN_PEPPER } = env;
  const shared =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_ENV
      ? getPayPal(
          {
            PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
            PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
            PAYPAL_ENV: env.PAYPAL_ENV,
          },
          app.log as unknown as Parameters<typeof getPayPal>[1],
          recordPayPalCall,
        )
      : undefined;
  const paypal = deps.paypal ?? shared;
  const vault = deps.vault ?? shared;
  const now = deps.now ? { now: deps.now } : {};
  // Voids go out with the payee merchant's own credentials; a merchant without them can't hold.
  const merchantPayPal: MerchantPayPalLookup =
    deps.merchantPayPal ??
    (env.MERCHANT_API_CREDENTIALS && env.PAYPAL_ENV
      ? createMerchantPayPal(env.MERCHANT_API_CREDENTIALS, {
          env: env.PAYPAL_ENV,
          logger: app.log as unknown as Parameters<typeof getPayPal>[1],
          onCall: recordPayPalCall,
        })
      : () => undefined);
  app.decorate(
    'jobDeps',
    env.DATABASE_URL && paypal
      ? {
          get db() {
            return app.db;
          },
          paypal,
          merchantPayPal,
          jobs,
          log: app.log,
          ...now,
        }
      : null,
  );
  // Phone pushes need the VAPID key pair and subject; without them holds still work, unpushed.
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  const sendPush =
    deps.sendPush ??
    (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT
      ? webPushSender({
          publicKey: VAPID_PUBLIC_KEY,
          privateKey: VAPID_PRIVATE_KEY,
          subject: VAPID_SUBJECT,
        })
      : undefined);
  if (!sendPush && VAPID_PUBLIC_KEY) app.log.warn('VAPID_SUBJECT is not set; phone pushes are off');
  // Pushes are fire-and-forget; shutdown waits for the ones still in flight.
  const inflight = new Set<Promise<void>>();
  app.addHook('preClose', async () => {
    await Promise.allSettled([...inflight]);
  });
  const push: PushService | undefined =
    sendPush && DATABASE_URL
      ? {
          sendApprovalPush: (userId, approvalId) => {
            const p = createPushService({
              db: app.db,
              send: sendPush,
              log: app.log,
              ...now,
            }).sendApprovalPush(userId, approvalId);
            inflight.add(p);
            void p.finally(() => inflight.delete(p));
            return p;
          },
        }
      : undefined;
  if (DATABASE_URL && RULE_HMAC_KEY && RULE_HMAC_KEY_ID && AGENT_TOKEN_PEPPER && paypal) {
    app.register(async (scope) => {
      await scope.register(agentRoutes, {
        db: app.db,
        paypal,
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        channel3: deps.channel3 ?? createChannel3Service(env.CHANNEL3_API_KEY),
        demoHoldMinutes: env.DEMO_HOLD_MINUTES,
        push,
        merchantPayPal,
        jobs,
        ...now,
      });
    });
  }

  if (env.EVAL_ENABLED && DATABASE_URL && RULE_HMAC_KEY && RULE_HMAC_KEY_ID && AGENT_TOKEN_PEPPER) {
    const { EVAL_ADMIN_TOKEN } = env;
    if (!EVAL_ADMIN_TOKEN) {
      throw new AppError(ErrorCode.CONFIG_INVALID, 'EVAL_ENABLED=true needs EVAL_ADMIN_TOKEN');
    }
    app.register(async (scope) => {
      await scope.register(internalEvalRoutes, {
        db: app.db,
        adminToken: EVAL_ADMIN_TOKEN,
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        signingKeyId: RULE_HMAC_KEY_ID,
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        ...now,
      });
    });
  }

  // Human routes additionally need the assertion public key and the web origin.
  const { HUMAN_ASSERTION_PUBLIC_KEY, WEB_ORIGIN } = env;
  if (
    DATABASE_URL &&
    RULE_HMAC_KEY &&
    RULE_HMAC_KEY_ID &&
    AGENT_TOKEN_PEPPER &&
    HUMAN_ASSERTION_PUBLIC_KEY &&
    WEB_ORIGIN &&
    vault
  ) {
    // One verifier for every /human/* route, so each assertion's jti is accepted only once.
    const verifier = createHumanAssertionVerifier(HUMAN_ASSERTION_PUBLIC_KEY, now);
    app.register(async (scope) => {
      await scope.register(humanRoutes, {
        db: app.db,
        vault,
        verifier,
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        signingKeyId: RULE_HMAC_KEY_ID,
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        webOrigin: WEB_ORIGIN,
        ...now,
      });
    });
    app.register(async (scope) => {
      await scope.register(pushRoutes, { db: app.db, verifier });
    });
    const balances =
      deps.balances ??
      createBalanceService({
        get db() {
          return app.db;
        },
        credentials: env.MERCHANT_API_CREDENTIALS,
        env: env.PAYPAL_ENV ?? 'sandbox',
        log: app.log,
        ...now,
      });
    app.register(async (scope) => {
      await scope.register(merchantRoutes, { verifier, balances });
    });
    // One LISTEN hub for the signed-in event stream and the public hijack stream.
    let hub: ReturnType<typeof createEventHub> | undefined;
    const sharedHub = () => {
      hub ??= createEventHub(DATABASE_URL, app.db, app.log);
      return hub;
    };
    app.addHook('onClose', async () => {
      await hub?.close();
    });
    app.register(async (scope) => {
      await scope.register(eventRoutes, {
        db: app.db,
        databaseUrl: DATABASE_URL,
        verifier,
        webOrigin: WEB_ORIGIN,
        hub: sharedHub(),
        ...(deps.eventsHeartbeatMs ? { heartbeatMs: deps.eventsHeartbeatMs } : {}),
      });
    });
    app.register(async (scope) => {
      await scope.register(hijackRoutes, {
        db: app.db,
        verifier,
        hub: sharedHub(),
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        ruleKey: Buffer.from(RULE_HMAC_KEY, 'base64'),
        webOrigin: WEB_ORIGIN,
        ...(deps.eventsHeartbeatMs ? { heartbeatMs: deps.eventsHeartbeatMs } : {}),
        ...now,
      });
    });
    if (paypal) {
      app.register(async (scope) => {
        await scope.register(humanApprovalRoutes, {
          db: app.db,
          paypal,
          merchantPayPal,
          jobs,
          verifier,
          ...now,
        });
      });
    }
  }

  return app;
}
