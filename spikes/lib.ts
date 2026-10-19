import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, createLogger, loadEnv } from '@twokey/core';
import { createPayPal, type PayPal } from '@twokey/paypal';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = resolve(ROOT, 'spikes/results');
export const SPIKE_RESULTS_MD = resolve(ROOT, 'docs/SPIKE_RESULTS.md');

export function setupPayPal(): PayPal {
  const env = loadEnv('gateway');
  return createPayPal({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    env: env.PAYPAL_ENV,
    logger: createLogger('gateway', env.LOG_LEVEL),
  });
}

export interface Merchant {
  slug: string;
  displayName: string;
  paypalMerchantId: string;
  role: 'allowed_demo' | 'attacker';
}

export function readMerchants(): Merchant[] {
  return JSON.parse(readFileSync(resolve(ROOT, 'config/merchants.json'), 'utf8')) as Merchant[];
}

export function writeResult(name: string, data: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = resolve(RESULTS_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export function readResult<T>(name: string): T | undefined {
  const file = resolve(RESULTS_DIR, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

export function appendSpikeResults(markdown: string): void {
  if (!existsSync(SPIKE_RESULTS_MD)) {
    writeFileSync(
      SPIKE_RESULTS_MD,
      '# Spike results\n\nAppended by `npm run spike:vault` and `npm run spike:honor`. ' +
        'Vault and payment-token IDs are never written here.\n',
    );
  }
  appendFileSync(SPIKE_RESULTS_MD, `\n${markdown.trimEnd()}\n`);
}

/** One-line description of a failure: PayPal name/issues/debug_id when present. */
export function describeError(err: unknown): string {
  if (err instanceof AppError) {
    const d = err.details ?? {};
    const parts = [`${err.code}: ${err.message}`];
    if (Array.isArray(d.issues) && d.issues.length) parts.push(`issues=${d.issues.join(',')}`);
    if (d.debug_id) parts.push(`debug_id=${String(d.debug_id)}`);
    if (d.orderId) parts.push(`orderId=${String(d.orderId)}`);
    return parts.join(' ');
  }
  return err instanceof Error ? err.message : String(err);
}

export function errorDetails(err: unknown): Record<string, unknown> {
  return err instanceof AppError
    ? { code: err.code, message: err.message, retryable: err.retryable, ...(err.details ?? {}) }
    : { message: describeError(err) };
}
