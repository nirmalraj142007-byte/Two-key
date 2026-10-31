import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  addLogContext,
  clientIp,
  createLogger,
  requestIdFrom,
  userIdHash,
  withLogContext,
} from '../src/index.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, logger: createLogger('gateway', 'info', stream) };
}

describe('log context', () => {
  it('adds the request and purchase IDs to every line inside the context, once', async () => {
    const { lines, logger } = capture();
    await withLogContext({ requestId: 'r1' }, async () => {
      await Promise.resolve();
      addLogContext({ proposalId: 'p1', userIdHash: userIdHash('u1') });
      logger.info({ paymentId: 'pay1' }, 'decision.made');
      logger.child({ requestId: 'r1' }).info('child line');
    });
    logger.info('outside');
    const [inside, child, outside] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(inside).toMatchObject({
      msg: 'decision.made',
      requestId: 'r1',
      proposalId: 'p1',
      paymentId: 'pay1',
      userIdHash: userIdHash('u1'),
      service: 'gateway',
    });
    // The child already binds requestId, so it appears exactly once in the raw JSON.
    expect(lines[1]?.match(/"requestId"/g)).toHaveLength(1);
    expect(child).toMatchObject({ requestId: 'r1', proposalId: 'p1' });
    expect(outside).not.toHaveProperty('requestId');
  });

  it('hashes user IDs to 12 hex characters and redacts vault IDs', () => {
    expect(userIdHash('user-1')).toMatch(/^[0-9a-f]{12}$/);
    const { lines, logger } = capture();
    logger.info({ payment: { vaultId: 'v-secret', paymentTokenId: 'pt-secret' } }, 'x');
    expect(lines[0]).not.toContain('v-secret');
    expect(lines[0]).not.toContain('pt-secret');
  });

  it('trusts an incoming request ID only when it is a UUID', () => {
    const id = '0198f3a2-1b2c-7d3e-8f40-123456789abc';
    expect(requestIdFrom(id)).toBe(id);
    expect(requestIdFrom(id.toUpperCase())).toBe(id);
    for (const bad of [undefined, '', 'abc', `${id}\n{"x":1}`, ['a', 'b']]) {
      const got = requestIdFrom(bad);
      expect(got).not.toBe(bad);
      expect(got).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('picks the rightmost x-forwarded-for entry from Headers and from Node header records', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
    expect(clientIp({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })).toBe('203.0.113.7');
    expect(clientIp({ 'x-real-ip': '198.51.100.2' })).toBe('198.51.100.2');
    expect(clientIp({})).toBe('unknown');
  });
});
