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

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
  logger: Logger;
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
    try {
      const res = await run();
      const raw = parseRaw(res.body);
      log.info(
        {
          ...op,
          status: res.statusCode,
          debug_id: debugIdOf(res.headers),
          ms: Date.now() - started,
        },
        'paypal call',
      );
      return { status: res.statusCode, raw };
    } catch (err) {
      // PayPal answered 2xx but the SDK's response schema disagreed: trust PayPal's JSON.
      if (err instanceof ResponseValidationError && err.statusCode < 300) {
        const raw = parseRaw(err.body);
        log.warn(
          {
            ...op,
            status: err.statusCode,
            debug_id: debugIdOf(err.headers),
            ms: Date.now() - started,
          },
          'paypal call (sdk response schema mismatch, using raw body)',
        );
        return { status: err.statusCode, raw };
      }
      if (err instanceof ApiError) {
        const appErr = mapPayPalError({ status: err.statusCode, headers: err.headers }, err.body);
        log.warn({ ...op, ...appErr.details, ms: Date.now() - started }, 'paypal call failed');
        throw appErr;
      }
      log.error({ ...op, ms: Date.now() - started, err: String(err) }, 'paypal call errored');
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
