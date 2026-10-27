import { describe, expect, it } from 'vitest';
import {
  isOpen,
  isUrgent,
  outcomeSentence,
  priceLine,
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

  it('decodes a base64url VAPID key', () => {
    expect([...urlBase64ToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });
});
