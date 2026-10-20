import { randomUUID } from 'node:crypto';
import { AppError, createLogger, type Env, ErrorCode, toHttp } from '@twokey/core';
import type { OrdersApi, VaultApi, VerifyWebhookSignature } from '@twokey/paypal';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createHumanAssertionVerifier } from './auth/human-assertion.js';
import { dbPlugin } from './plugins/db.js';
import { agentRoutes } from './routes/agent.js';
import { type HealthPayPal, healthRoutes } from './routes/health.js';
import { humanRoutes } from './routes/human.js';
import { webhookRoutes } from './routes/webhooks.js';
import { loadRuleKeys } from './services/keys.js';
import { getPayPal } from './services/paypal.js';

export type AppEnv = Pick<Env<'gateway'>, 'LOG_LEVEL'> &
  Partial<
    Pick<
      Env<'gateway'>,
      | 'DATABASE_URL'
      | 'PAYPAL_WEBHOOK_ID'
      | 'PUBLIC_BASE_URL'
      | 'PAYPAL_ENV'
      | 'PAYPAL_CLIENT_ID'
      | 'PAYPAL_CLIENT_SECRET'
      | 'RULE_HMAC_KEY'
      | 'RULE_HMAC_KEY_ID'
      | 'AGENT_TOKEN_PEPPER'
      | 'DEMO_HOLD_MINUTES'
      | 'HUMAN_ASSERTION_PUBLIC_KEY'
      | 'WEB_ORIGIN'
    >
  >;

export interface AppDeps {
  verifyWebhookSignature?: VerifyWebhookSignature;
  /** PayPal calls behind /healthz/deep. */
  paypalHealth?: HealthPayPal;
  /** Replaces the `select 1` DB check (tests). */
  checkDb?: () => Promise<void>;
  /** Replaces the process-wide PayPal client (tests). */
  paypal?: Pick<OrdersApi, 'createVaultedAuthorization' | 'capture'>;
  /** Replaces the process-wide PayPal vault client (tests). */
  vault?: Pick<VaultApi, 'createSetupToken' | 'createPaymentToken' | 'deletePaymentToken'>;
  now?: () => Date;
}

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
    if (status >= 500) req.log.error({ err }, 'request failed');
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
  app.register(webhookRoutes, {
    webhookId: env.PAYPAL_WEBHOOK_ID,
    verify: deps.verifyWebhookSignature,
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
  if (DATABASE_URL && RULE_HMAC_KEY && RULE_HMAC_KEY_ID && AGENT_TOKEN_PEPPER && paypal) {
    app.register(async (scope) => {
      await scope.register(agentRoutes, {
        db: app.db,
        paypal,
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        demoHoldMinutes: env.DEMO_HOLD_MINUTES,
        ...(deps.now ? { now: deps.now } : {}),
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
    app.register(async (scope) => {
      await scope.register(humanRoutes, {
        db: app.db,
        vault,
        verifier: createHumanAssertionVerifier(
          HUMAN_ASSERTION_PUBLIC_KEY,
          deps.now ? { now: deps.now } : {},
        ),
        keys: loadRuleKeys({ RULE_HMAC_KEY, RULE_HMAC_KEY_ID }),
        signingKeyId: RULE_HMAC_KEY_ID,
        agentTokenPepper: AGENT_TOKEN_PEPPER,
        webOrigin: WEB_ORIGIN,
        ...(deps.now ? { now: deps.now } : {}),
      });
    });
  }

  return app;
}
