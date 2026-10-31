import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../lib/csp';
import { clearLoginAttempts, consumeLoginAttempt, LOGIN_POINTS } from '../lib/rate-limit';

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy({
    nonce: 'abc123',
    gatewayUrl: 'https://gateway.example.com/some/path',
    dev: false,
  });

  it('allows scripts only by nonce, and connects only to itself and the gateway', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'self' https://gateway.example.com;");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("adds 'unsafe-eval' in development only", () => {
    expect(contentSecurityPolicy({ nonce: 'n', gatewayUrl: undefined, dev: true })).toContain(
      "'unsafe-eval'",
    );
  });
});

describe('login rate limit', () => {
  it('allows 5 attempts a minute per IP hash, and a successful sign-in clears them', async () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < LOGIN_POINTS; i++) expect(await consumeLoginAttempt(key)).toBe(true);
    expect(await consumeLoginAttempt(key)).toBe(false);
    expect(await consumeLoginAttempt(`${key}-other`)).toBe(true);
    await clearLoginAttempts(key);
    expect(await consumeLoginAttempt(key)).toBe(true);
  });
});
