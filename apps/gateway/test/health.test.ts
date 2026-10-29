import { REQUIRED_WEBHOOK_EVENTS } from '@twokey/core';
import type { WebhookSubscription } from '@twokey/paypal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  /** Each flag can be flipped between checks to model PayPal going down and coming back. */
  function paypalSetup(over: { authFails?: boolean; lagging?: boolean; missing?: boolean } = {}) {
    const flags = { ...over };
    const paypal = {
      checkAuth: vi.fn(async () => {
        if (flags.authFails) throw new Error('401');
      }),
      listWebhooks: vi.fn(
        async (): Promise<WebhookSubscription[]> => [
          {
            id: HOOK_ID,
            url: `${BASE}/webhooks/paypal`,
            eventTypes: flags.missing
              ? REQUIRED_WEBHOOK_EVENTS.filter((e) => e !== 'PAYMENT.CAPTURE.DENIED')
              : [...REQUIRED_WEBHOOK_EVENTS],
          },
        ],
      ),
    };
    const webhookLagSince = vi.fn(async (_since: Date) => flags.lagging === true);
    const app = buildApp(
      { LOG_LEVEL: 'silent', PAYPAL_WEBHOOK_ID: HOOK_ID, PUBLIC_BASE_URL: BASE },
      { paypalHealth: paypal, checkDb: async () => undefined, webhookLagSince },
    );
    return { app, paypal, webhookLagSince, flags };
  }

  // Answers are cached for 60 s, so each new check happens one minute after the last.
  const START = new Date('2026-10-19T00:00:00Z').getTime();
  let minute = 0;
  async function check(app: ReturnType<typeof paypalSetup>['app']) {
    vi.setSystemTime(START + minute * 60_000);
    minute += 1;
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.statusCode).toBe(200);
    return res.json() as { degraded: boolean; reason?: string };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    minute = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is public and reports healthy', async () => {
    const { app } = paypalSetup();
    expect(await check(app)).toEqual({ degraded: false });
  });

  it('is not degraded after one failed check, only after two in a row', async () => {
    const { app, paypal } = paypalSetup({ authFails: true });
    expect(await check(app)).toEqual({ degraded: false });
    expect(await check(app)).toEqual({ degraded: true, reason: 'paypal_unreachable' });
    expect(await check(app)).toEqual({ degraded: true, reason: 'paypal_unreachable' });
    expect(paypal.checkAuth).toHaveBeenCalledTimes(3);
  });

  it('clears after one successful check, then needs two new failures', async () => {
    const { app, flags } = paypalSetup({ authFails: true });
    await check(app);
    expect((await check(app)).degraded).toBe(true);
    flags.authFails = false;
    expect(await check(app)).toEqual({ degraded: false });
    flags.authFails = true;
    expect(await check(app)).toEqual({ degraded: false });
    expect((await check(app)).degraded).toBe(true);
  });

  it('never reports degraded when failures alternate with successes', async () => {
    const { app, flags } = paypalSetup();
    for (let i = 0; i < 6; i++) {
      flags.authFails = i % 2 === 0;
      expect(await check(app)).toEqual({ degraded: false });
    }
  });

  it('counts a check once, however often its cached answer is read', async () => {
    const { app } = paypalSetup({ authFails: true });
    vi.setSystemTime(START);
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
      expect(res.json()).toEqual({ degraded: false });
    }
    // /healthz/deep reads the same PayPal result within the minute: still one check.
    await app.inject({ method: 'GET', url: '/healthz/deep' });
    vi.setSystemTime(START + 30_000);
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.json()).toEqual({ degraded: false });
  });

  it('applies the same rule to an incomplete webhook subscription', async () => {
    const { app } = paypalSetup({ missing: true });
    expect(await check(app)).toEqual({ degraded: false });
    expect(await check(app)).toEqual({ degraded: true, reason: 'webhook_subscription' });
  });

  it('applies the same rule to payments waiting with no webhook for 30 minutes', async () => {
    const { app, webhookLagSince } = paypalSetup({ lagging: true });
    expect(await check(app)).toEqual({ degraded: false });
    expect(await check(app)).toEqual({ degraded: true, reason: 'webhook_lag' });
    const since = webhookLagSince.mock.calls[0]?.[0];
    expect(since).toBeInstanceOf(Date);
    expect(START - (since as Date).getTime()).toBe(30 * 60_000);
  });

  it('caches its answer for 60 seconds', async () => {
    vi.setSystemTime(START);
    const { app, webhookLagSince } = paypalSetup();
    await app.inject({ method: 'GET', url: '/healthz/paypal' });
    vi.setSystemTime(START + 59_000);
    const res = await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(webhookLagSince).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 60_000);
    await app.inject({ method: 'GET', url: '/healthz/paypal' });
    expect(webhookLagSince).toHaveBeenCalledTimes(2);
  });
});
