import { randomUUID } from 'node:crypto';
import { AppError, createLogger, type Env, ErrorCode, toHttp } from '@twokey/core';
import {
  createMerchantPayPal,
  type MerchantPayPalLookup,
  type OrdersApi,
  type VaultApi,
  type VerifyWebhookSignature,
} from '@twokey/paypal';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createHumanAssertionVerifier } from './auth/human-assertion.js';
import { createJobRunner } from './jobs/boss.js';
import type { Jobs } from './jobs/queue.js';
import { dbPlugin } from './plugins/db.js';
import { agentRoutes } from './routes/agent.js';
import { eventRoutes } from './routes/events.js';
import { type HealthPayPal, healthRoutes } from './routes/health.js';
import { humanRoutes } from './routes/human.js';
import { humanApprovalRoutes } from './routes/human-approvals.js';
import { internalEvalRoutes } from './routes/internal-eval.js';
import { webhookRoutes } from './routes/webhooks.js';
import { type Channel3Service, createChannel3Service } from './services/channel3.js';
import { loadRuleKeys } from './services/keys.js';
import { getPayPal } from './services/paypal.js';

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
    >
  >;

export interface AppDeps {
  verifyWebhookSignature?: VerifyWebhookSignature;
  /** PayPal calls behind /healthz/deep. */
  paypalHealth?: HealthPayPal;
  /** Replaces the `select 1` DB check (tests). */
  checkDb?: () => Promise<void>;
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
  /** SSE heartbeat interval on /human/events (tests shorten it). */
  eventsHeartbeatMs?: number;
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

export function buildApp(env: AppEnv, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: createLogger('gateway', env.LOG_LEVEL) as FastifyBaseLogger,
    genReqId: () => randomUUID(),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

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
  if (DATABASE_URL && RULE_HMAC_KEY && RULE_HMAC_KEY_ID && AGENT_TOKEN_PEPPER && paypal) {
    app.register(async (scope) => {
      await scope.register(agentRoutes, {
        db: app.db,
        paypal,
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        channel3: deps.channel3 ?? createChannel3Service(env.CHANNEL3_API_KEY),
        demoHoldMinutes: env.DEMO_HOLD_MINUTES,
        merchantPayPal,
        jobs,
        ...now,
      });
    });
  }

  // Evaluation session minting: only when explicitly enabled, never in production.
  if (env.EVAL_ENABLED && env.NODE_ENV === 'production') {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'EVAL_ENABLED must not be set in production');
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
      await scope.register(eventRoutes, {
        db: app.db,
        databaseUrl: DATABASE_URL,
        verifier,
        webOrigin: WEB_ORIGIN,
        ...(deps.eventsHeartbeatMs ? { heartbeatMs: deps.eventsHeartbeatMs } : {}),
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
