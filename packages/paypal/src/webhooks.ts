import { AppError, ErrorCode } from '@twokey/core';
import { PAYPAL_BASE_URL } from './client.js';
import { mapPayPalError } from './errors.js';
import { str } from './raw.js';

export interface VerifyWebhookInput {
  /** Request headers, lower-cased (as Node delivers them). */
  headers: Record<string, string>;
  /** The request body exactly as PayPal sent it; PayPal signed these bytes. */
  rawBody: string;
  webhookId: string;
}

export type VerifyWebhookSignature = (i: VerifyWebhookInput) => Promise<'SUCCESS' | 'FAILURE'>;

export interface WebhookVerifierConfig {
  clientId: string;
  clientSecret: string;
  env: 'sandbox' | 'live';
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

function unreachable(cause: unknown): AppError {
  return new AppError(ErrorCode.UPSTREAM_PAYPAL, 'PayPal webhook verification unavailable', {
    retryable: true,
    cause,
  });
}

/**
 * Builds `verifyWebhookSignature`, which asks PayPal (POST /v1/notifications/verify-webhook-signature)
 * whether an event really came from PayPal. Network failures and 5xx throw a retryable
 * AppError(UPSTREAM_PAYPAL); a request missing any paypal-* signature header is a FAILURE
 * without calling PayPal.
 */
export function createWebhookVerifier(cfg: WebhookVerifierConfig): VerifyWebhookSignature {
  const base = PAYPAL_BASE_URL[cfg.env];
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  let token: { value: string; expiresAt: number } | undefined;

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw unreachable(err);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw mapPayPalError(
        {
          status: res.status,
          headers: { 'paypal-debug-id': res.headers.get('paypal-debug-id') ?? undefined },
        },
        text,
      );
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (err) {
      throw unreachable(err);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now()) return token.value;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const raw = await call('/v1/oauth2/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const value = str(raw.access_token);
    if (!value) throw unreachable(new Error('OAuth response has no access_token'));
    const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 0;
    token = { value, expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000 };
    return value;
  }

  return async ({ headers, rawBody, webhookId }) => {
    let fields = '';
    for (const [field, header] of Object.entries(SIGNATURE_HEADERS)) {
      const value = headers[header];
      if (!value) return 'FAILURE';
      fields += `${JSON.stringify(field)}:${JSON.stringify(value)},`;
    }
    // Splice the event in as raw text: re-serializing it (1.10 -> 1.1, \u00e9 -> é) would
    // change the bytes PayPal signed and make a genuine event fail verification.
    const body = `{${fields}"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`;
    const raw = await call('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
      },
      body,
    });
    return raw.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
  };
}
