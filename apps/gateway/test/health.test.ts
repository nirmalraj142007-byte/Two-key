import { REQUIRED_WEBHOOK_EVENTS } from '@twokey/core';
import type { WebhookSubscription } from '@twokey/paypal';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';

const BASE = 'https://gw.example.test';
const HOOK_ID = 'WH-123';

function setup(
  over: { hook?: Partial<WebhookSubscription>; authFails?: boolean; dbFails?: boolean } = {},
) {
  const paypal = {
    checkAuth: vi.fn(async () => {
      if (over.authFails) throw new Error('401');
    }),
    listWebhooks: vi.fn(
      async (): Promise<WebhookSubscription[]> => [
        {
          id: HOOK_ID,
          url: `${BASE}/webhooks/paypal`,
          eventTypes: [...REQUIRED_WEBHOOK_EVENTS],
          ...over.hook,
        },
      ],
    ),
  };
  const app = buildApp(
    { LOG_LEVEL: 'silent', PAYPAL_WEBHOOK_ID: HOOK_ID, PUBLIC_BASE_URL: BASE },
    {
      paypalHealth: paypal,
      checkDb: async () => {
        if (over.dbFails) throw new Error('db down');
      },
    },
  );
  return { app, paypal };
}

describe('GET /healthz/deep', () => {
  it('returns 200 when the db, PayPal auth and the webhook subscription are all ok', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz/deep' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: 'ok', paypalAuth: 'ok', webhookSubscriptions: 'ok' });
  });

  it('returns 503 listing a missing event', async () => {
    const { app } = setup({
      hook: { eventTypes: REQUIRED_WEBHOOK_EVENTS.filter((e) => e !== 'PAYMENT.CAPTURE.DENIED') },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz/deep' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      db: 'ok',
      paypalAuth: 'ok',
      webhookSubscriptions: 'missing_events',
      missing: ['PAYMENT.CAPTURE.DENIED'],
    });
  });

  it('returns 503 when the webhook points at another URL', async () => {
    const { app } = setup({ hook: { url: 'https://elsewhere.example.test/webhooks/paypal' } });
    const res = await app.inject({ method: 'GET', url: '/healthz/deep' });
    expect(res.statusCode).toBe(503);
    expect(res.json().webhookSubscriptions).toBe('wrong_url');
  });

  it('returns 503 when the db or PayPal auth fails, while /healthz stays 200', async () => {
    const { app } = setup({ authFails: true, dbFails: true });
    const deep = await app.inject({ method: 'GET', url: '/healthz/deep' });
    expect(deep.statusCode).toBe(503);
    expect(deep.json()).toEqual({ db: 'fail', paypalAuth: 'fail', webhookSubscriptions: 'fail' });
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
  });

  it('reuses PayPal results for 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
      const { app, paypal } = setup();
      await app.inject({ method: 'GET', url: '/healthz/deep' });
      vi.setSystemTime(new Date('2026-10-19T00:00:59Z'));
      await app.inject({ method: 'GET', url: '/healthz/deep' });
      expect(paypal.checkAuth).toHaveBeenCalledTimes(1);
      expect(paypal.listWebhooks).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-19T00:01:00Z'));
      await app.inject({ method: 'GET', url: '/healthz/deep' });
      expect(paypal.checkAuth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GET /healthz/paypal', () => {
  function paypalSetup(over: { authFails?: boolean; lagging?: boolean; missing?: boolean } = {}) {
    const paypal = {
      checkAuth: vi.fn(async () => {
        if (over.authFails) throw new Error('401');
      }),
      listWebhooks: vi.fn(
        async (): Promise<WebhookSubscription[]> => [
          {
            id: HOOK_ID,
            url: `${BASE}/webhooks/paypal`,
            eventTypes: over.missing
              ? REQUIRED_WEBHOOK_EVENTS.filter((e) => e !== 'PAYMENT.CAPTURE.DENIED')
              : [...REQUIRED_WEBHOOK_EVENTS],
          },
        ],
      ),
    };
    const webhookLagSince = vi.fn(async (_since: Date) => over.lagging === true);
    const app = buildApp(
      { LOG_LEVEL: 'silent', PAYPAL_WEBHOOK_ID: HOOK_ID, PUBLIC_BASE_URL: BASE },
      { paypalHealth: paypal, checkDb: async () => undefined, webhookLagSince },
    );
    return { app, paypal, webhookLagSince };
  }

  it('is public and reports healthy', async () => {
    const { app } = paypalSetup();
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ degraded: false });
  });

  it('is degraded when PayPal auth fails', async () => {
    const { app } = paypalSetup({ authFails: true });
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.json()).toEqual({ degraded: true, reason: 'paypal_unreachable' });
  });

  it('is degraded when the webhook subscription is incomplete', async () => {
    const { app } = paypalSetup({ missing: true });
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.json()).toEqual({ degraded: true, reason: 'webhook_subscription' });
  });

  it('is degraded when payments wait and no webhook arrived in 30 minutes', async () => {
    const { app, webhookLagSince } = paypalSetup({ lagging: true });
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.json()).toEqual({ degraded: true, reason: 'webhook_lag' });
    const since = webhookLagSince.mock.calls[0]?.[0];
    expect(since).toBeInstanceOf(Date);
    expect(before - (since as Date).getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
  });

  it('caches its answer for 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
      const { app, webhookLagSince } = paypalSetup();
      await app.inject({ method: 'GET', url: '/healthz/paypal' });
      vi.setSystemTime(new Date('2026-10-19T00:00:59Z'));
      const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(webhookLagSince).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-10-19T00:01:00Z'));
      await app.inject({ method: 'GET', url: '/healthz/paypal' });
      expect(webhookLagSince).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
