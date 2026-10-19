import { readFileSync } from 'node:fs';
import { AppError, ErrorCode } from '@twokey/core';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookVerifier } from '../src/webhooks.js';

const headers = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': '2026-10-19T09:12:52Z',
};
const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' };
const rawBody = JSON.stringify(event);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function verifierWith(verifyResponse: () => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/v1/oauth2/token')
      ? json(200, { access_token: 'A21', expires_in: 32400 })
      : verifyResponse(),
  );
  const verify = createWebhookVerifier({
    clientId: 'id',
    clientSecret: 's',
    env: 'sandbox',
    fetch,
  });
  return { verify, fetch };
}

const sentBody = (fetch: ReturnType<typeof verifierWith>['fetch']) =>
  String(
    fetch.mock.calls.find(([u]) => String(u).endsWith('/verify-webhook-signature'))?.[1]?.body,
  );

describe('verifyWebhookSignature', () => {
  it('posts the signature headers, webhook id and event to PayPal', async () => {
    const { verify, fetch } = verifierWith(() => json(200, { verification_status: 'SUCCESS' }));
    await expect(verify({ headers, rawBody, webhookId: 'WH-ID' })).resolves.toBe('SUCCESS');

    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/verify-webhook-signature'));
    expect(String(call?.[0])).toBe(
      'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature',
    );
    expect(JSON.parse(sentBody(fetch))).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: headers['paypal-cert-url'],
      transmission_id: 'tx-1',
      transmission_sig: 'sig',
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: 'WH-ID',
      webhook_event: event,
    });
  });

  it('splices the raw event into the request byte-for-byte', async () => {
    // The fixture holds 1.10 and \u00e9 / \u2014 escapes; JSON.parse + stringify would
    // rewrite them (1.1, literal characters) and break PayPal's signature check.
    const raw = readFileSync(new URL('./fixtures/raw-event.json', import.meta.url), 'utf8').trim();
    expect(raw).toContain('"exchange_rate":1.10');
    expect(raw).toContain(String.raw`Caf\u00e9`);
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);

    const { verify, fetch } = verifierWith(() => json(200, { verification_status: 'SUCCESS' }));
    await verify({ headers, rawBody: raw, webhookId: 'WH-ID' });
    const sent = sentBody(fetch);
    expect(sent).toContain(raw);
    expect(sent.endsWith(`"webhook_id":"WH-ID","webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(sent).auth_algo).toBe('SHA256withRSA');
  });

  it('returns FAILURE when PayPal says so', async () => {
    const { verify } = verifierWith(() => json(200, { verification_status: 'FAILURE' }));
    await expect(verify({ headers, rawBody, webhookId: 'WH-ID' })).resolves.toBe('FAILURE');
  });

  it('returns FAILURE without calling PayPal when a signature header is missing', async () => {
    const { verify, fetch } = verifierWith(() => json(200, { verification_status: 'SUCCESS' }));
    const { 'paypal-transmission-sig': _sig, ...partial } = headers;
    await expect(verify({ headers: partial, rawBody, webhookId: 'WH-ID' })).resolves.toBe(
      'FAILURE',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws a retryable UPSTREAM_PAYPAL on 5xx', async () => {
    const { verify } = verifierWith(() => json(503, { name: 'SERVICE_UNAVAILABLE' }));
    const err = await verify({ headers, rawBody, webhookId: 'WH-ID' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: ErrorCode.UPSTREAM_PAYPAL, retryable: true });
  });

  it('throws a retryable UPSTREAM_PAYPAL on a network failure', async () => {
    const { verify } = verifierWith(() => {
      throw new TypeError('fetch failed');
    });
    const err = await verify({ headers, rawBody, webhookId: 'WH-ID' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.UPSTREAM_PAYPAL, retryable: true });
  });
});
