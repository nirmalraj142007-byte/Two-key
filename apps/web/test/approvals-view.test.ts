import { describe, expect, it } from 'vitest';
import {
  isOpen,
  isUrgent,
  isValidVapidKey,
  outcomeSentence,
  priceLine,
  sameKey,
  urlBase64ToBytes,
} from '../lib/approvals-view';

describe('approvals view', () => {
  it('states the hold reason from structured fields only', () => {
    expect(priceLine({ ratio: 1.4, referencePrice: '$46.00', referenceOffers: 3 })).toBe(
      '40% above the usual price of $46.00 (3 stores)',
    );
    expect(priceLine({ ratio: 1.35, referencePrice: '$20.00', referenceOffers: null })).toBe(
      '35% above the usual price of $20.00',
    );
    expect(priceLine({ ratio: null, referencePrice: null, referenceOffers: null })).toBe(
      'The price looks unusual.',
    );
  });

  it('flags holds under 10 minutes from their deadline', () => {
    const now = Date.parse('2026-10-27T10:00:00Z');
    expect(isUrgent('2026-10-27T10:09:00Z', now)).toBe(true);
    expect(isUrgent('2026-10-27T10:11:00Z', now)).toBe(false);
    expect(isUrgent('2026-10-27T09:59:00Z', now)).toBe(false);
  });

  it('is open only while pending and held', () => {
    expect(isOpen({ status: 'pending', state: 'held' })).toBe(true);
    expect(isOpen({ status: 'pending', state: 'void_requested' })).toBe(false);
    expect(isOpen({ status: 'denied', state: 'voided' })).toBe(false);
  });

  it('says no charge for every closed state but captured', () => {
    expect(outcomeSentence('voided')).toBe('Voided. No charge was made.');
    expect(outcomeSentence('expired')).toContain('No charge');
    expect(outcomeSentence('captured')).toContain('captured');
  });

  it('tells whether an existing subscription used our VAPID key', () => {
    const key = urlBase64ToBytes('AQID_-8');
    expect(sameKey(new Uint8Array([1, 2, 3, 255, 239]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([4, 4, 4, 4, 4]).buffer, key)).toBe(false);
    expect(sameKey(new Uint8Array([1, 2, 3]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });

  it('accepts only a 65-byte uncompressed P-256 public key', () => {
    const point = Buffer.from([4, ...new Array(64).fill(7)]).toString('base64url');
    expect(isValidVapidKey(point)).toBe(true);
    expect(isValidVapidKey('dummy')).toBe(false);
    expect(isValidVapidKey(Buffer.from([4, 1, 2]).toString('base64url'))).toBe(false);
    expect(isValidVapidKey(`${point.slice(0, -1)}+`)).toBe(false);
    expect(isValidVapidKey(undefined)).toBe(false);
  });

  it('decodes a base64url VAPID key', () => {
    expect([...urlBase64ToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});
