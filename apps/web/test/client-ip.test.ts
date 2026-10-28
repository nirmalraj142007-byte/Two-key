import { describe, expect, it } from 'vitest';
import { clientIp } from '../lib/client-ip';

const h = (init: Record<string, string>) => new Headers(init);

describe('clientIp', () => {
  it('keys on the rightmost x-forwarded-for entry, the one our proxy appends', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores whatever a client puts to the left, so spoofing gives no new tries', () => {
    const real = '203.0.113.7';
    const keys = ['9.9.9.1', '9.9.9.2', '10.0.0.1, 9.9.9.3'].map((spoof) =>
      clientIp(h({ 'x-forwarded-for': `${spoof}, ${real}` })),
    );
    expect(new Set(keys)).toEqual(new Set([real]));
  });

  it('skips empty entries and falls back to x-real-ip, then unknown', () => {
    expect(clientIp(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7 , ' }))).toBe('203.0.113.7');
    expect(clientIp(h({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(h({}))).toBe('unknown');
  });
});
