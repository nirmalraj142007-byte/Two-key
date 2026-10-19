import { AppError, ErrorCode } from '@twokey/core';
import { PAYPAL_BASE_URL } from './client.js';
import { mapPayPalError } from './errors.js';
import { obj, str } from './raw.js';

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

interface RestClient {
  call(path: string, init: RequestInit): Promise<Record<string, unknown>>;
  accessToken(): Promise<string>;
}

/** Small fetch client for the REST endpoints the Server SDK doesn't cover (notifications). */
function createRestClient(cfg: WebhookVerifierConfig): RestClient {
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
    if (text.trim() === '') return {};
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

  return { call, accessToken };
}

/**
 * Builds `verifyWebhookSignature`, which asks PayPal (POST /v1/notifications/verify-webhook-signature)
 * whether an event really came from PayPal. Network failures and 5xx throw a retryable
 * AppError(UPSTREAM_PAYPAL); a request missing any paypal-* signature header is a FAILURE
 * without calling PayPal.
 */
export function createWebhookVerifier(cfg: WebhookVerifierConfig): VerifyWebhookSignature {
  const { call, accessToken } = createRestClient(cfg);

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

export interface WebhookSubscription {
  id: string;
  url: string;
  eventTypes: string[];
}

export interface WebhookApi {
  /** Fetches (or reuses) an OAuth token; throws if PayPal rejects the credentials. */
  checkAuth(): Promise<void>;
  listWebhooks(): Promise<WebhookSubscription[]>;
  createWebhook(i: { url: string; eventTypes: string[] }): Promise<WebhookSubscription>;
  updateWebhookEvents(id: string, eventTypes: string[]): Promise<WebhookSubscription>;
}

function toSubscription(raw: Record<string, unknown>): WebhookSubscription {
  const types = Array.isArray(raw.event_types) ? raw.event_types : [];
  return {
    id: str(raw.id),
    url: str(raw.url),
    eventTypes: types.map((t) => str(obj(t).name)).filter((n) => n !== ''),
  };
}

const eventTypesBody = (eventTypes: string[]) => eventTypes.map((name) => ({ name }));

/** Webhook subscription management (GET/POST/PATCH /v1/notifications/webhooks). */
export function createWebhookApi(cfg: WebhookVerifierConfig): WebhookApi {
  const { call, accessToken } = createRestClient(cfg);
  const json = async () => ({
    authorization: `Bearer ${await accessToken()}`,
    'content-type': 'application/json',
  });

  return {
    async checkAuth() {
      await accessToken();
    },
    async listWebhooks() {
      const raw = await call('/v1/notifications/webhooks', {
        method: 'GET',
        headers: await json(),
      });
      const list = Array.isArray(raw.webhooks) ? raw.webhooks : [];
      return list.map((w) => toSubscription(obj(w)));
    },
    async createWebhook({ url, eventTypes }) {
      const raw = await call('/v1/notifications/webhooks', {
        method: 'POST',
        headers: await json(),
        body: JSON.stringify({ url, event_types: eventTypesBody(eventTypes) }),
      });
      return toSubscription(raw);
    },
    async updateWebhookEvents(id, eventTypes) {
      const raw = await call(`/v1/notifications/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: await json(),
        body: JSON.stringify([
          { op: 'replace', path: '/event_types', value: eventTypesBody(eventTypes) },
        ]),
      });
      return toSubscription(raw);
    },
  };
}
