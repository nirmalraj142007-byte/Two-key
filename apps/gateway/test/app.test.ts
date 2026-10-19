import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('gateway app', () => {
  const app = buildApp({ LOG_LEVEL: 'silent' });

  it('GET /healthz returns service info and a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: 'gateway' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('unknown routes return a NOT_FOUND error body', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });
});
