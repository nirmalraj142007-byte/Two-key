import {
  ApiError,
  type ApiResponse,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  ResponseValidationError,
  VaultController,
} from '@paypal/paypal-server-sdk';
import { AppError, type createLogger, ErrorCode } from '@twokey/core';
import { mapPayPalError } from './errors.js';
import { createOrdersApi, type OrdersApi } from './orders.js';
import { createVaultApi, type VaultApi } from './vault.js';

export type Logger = ReturnType<typeof createLogger>;

/** One finished PayPal call, as logged (`paypal.call`) and counted in metrics. */
export interface PayPalCallEvent {
  /** Method and templated path, e.g. `POST /v2/payments/authorizations/{id}/capture`. */
  op: string;
  /** HTTP status, or 0 when PayPal could not be reached. */
  status: number;
  durationMs: number;
  debugId: string | undefined;
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
  logger: Logger;
  /** Called once per call, after it finishes (metrics). Must not throw. */
  onCall?: (e: PayPalCallEvent) => void;
}

export const PAYPAL_BASE_URL = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

/**
 * One PayPal call. `path` is what gets logged, so it must never contain a vault or
 * payment-token ID (use a template such as `/v3/vault/payment-tokens/{id}`).
 */
export interface PayPalOp {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
}

export interface PayPalResult {
  status: number;
  /** Parsed PayPal JSON exactly as sent (snake_case); `{}` for an empty body. */
  raw: Record<string, unknown>;
}

export interface PayPalContext {
  orders: OrdersController;
  payments: PaymentsController;
  vault: VaultController;
  exec(op: PayPalOp, run: () => Promise<ApiResponse<unknown>>): Promise<PayPalResult>;
}

export type PayPal = VaultApi & OrdersApi;

function parseRaw(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string' || body.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** `/v2/payments/authorizations/5O1901…/capture` → `/v2/payments/authorizations/{id}/capture`. */
export function templatePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (/\d/.test(seg) && !/^v\d+$/.test(seg) ? '{id}' : seg))
    .join('/');
}

function debugIdOf(headers: Record<string, string> | undefined, raw?: Record<string, unknown>) {
  const fromBody = raw?.debug_id;
  return headers?.['paypal-debug-id'] ?? (typeof fromBody === 'string' ? fromBody : undefined);
}

export function createPayPal(cfg: PayPalConfig): PayPal {
  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: cfg.clientId,
      oAuthClientSecret: cfg.clientSecret,
    },
    environment: cfg.env === 'live' ? Environment.Production : Environment.Sandbox,
    timeout: 30_000,
  });
  const log = cfg.logger.child({ component: 'paypal' });

  async function exec(
    op: PayPalOp,
    run: () => Promise<ApiResponse<unknown>>,
  ): Promise<PayPalResult> {
    const started = Date.now();
    const opName = `${op.method} ${templatePath(op.path)}`;
    const done = (status: number, debugId: string | undefined) => {
      const e = { op: opName, status, durationMs: Date.now() - started, debugId };
      try {
        cfg.onCall?.(e);
      } catch {
        // metrics never break a payment
      }
      return e;
    };
    try {
      const res = await run();
      const raw = parseRaw(res.body);
      log.info(done(res.statusCode, debugIdOf(res.headers)), 'paypal.call');
      return { status: res.statusCode, raw };
    } catch (err) {
      // PayPal answered 2xx but the SDK's response schema disagreed: trust PayPal's JSON.
      if (err instanceof ResponseValidationError && err.statusCode < 300) {
        const raw = parseRaw(err.body);
        log.warn(
          { ...done(err.statusCode, debugIdOf(err.headers)), schemaMismatch: true },
          'paypal.call',
        );
        return { status: err.statusCode, raw };
      }
      if (err instanceof ApiError) {
        const appErr = mapPayPalError({ status: err.statusCode, headers: err.headers }, err.body);
        const debugId = appErr.details?.debug_id;
        log.warn(
          {
            ...done(err.statusCode, typeof debugId === 'string' ? debugId : undefined),
            issues: appErr.details?.issues,
          },
          'paypal.call',
        );
        throw appErr;
      }
      log.error({ ...done(0, undefined), err: String(err) }, 'paypal.call');
      throw new AppError(ErrorCode.UPSTREAM_PAYPAL, 'PayPal unreachable', {
        retryable: true,
        cause: err,
      });
    }
  }

  const ctx: PayPalContext = {
    orders: new OrdersController(client),
    payments: new PaymentsController(client),
    vault: new VaultController(client),
    exec,
  };
  return { ...createVaultApi(ctx), ...createOrdersApi(ctx) };
}
