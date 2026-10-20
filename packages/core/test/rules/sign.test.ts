import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { RuleCard } from '../../src/rules/schema.js';
import { fingerprint, signCard, verifyCard } from '../../src/rules/sign.js';
import { demoCard, NOW } from './fixtures.js';

const oldKey = { id: 'k1', secret: randomBytes(32) };
const newKey = { id: 'k2', secret: randomBytes(32) };
const keys = { [oldKey.id]: oldKey.secret, [newKey.id]: newKey.secret };

function reason(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('RULE_CARD_INVALID');
    return (e as AppError).details?.reason;
  }
  throw new Error('expected verifyCard to throw');
}

/** A different value of the same type for each top-level field. */
function mutate(card: RuleCard, key: keyof RuleCard): Record<string, unknown> {
  const v = card[key];
  let next: unknown;
  if (typeof v === 'number') next = v + 1;
  else if (key === 'expiresAt') next = '2027-01-01T00:00:00.000Z';
  else if (typeof v === 'string') next = `${v}x`;
  else if (Array.isArray(v)) next = [...v, v[0] ?? { key: 'size', value: '10', label: 'size' }];
  else if (v === undefined) next = ['gift_cards'];
  else next = { ...(v as object), extra: 1 };
  return { ...card, [key]: next };
}

describe('signCard / verifyCard', () => {
  it('round-trips', () => {
    const card = demoCard();
    const signed = signCard(card, newKey);
    expect(signed.alg).toBe('HS256');
    expect(signed.keyId).toBe('k2');
    expect(verifyCard(signed, keys, NOW)).toEqual(card);
  });

  it('does not depend on key order', () => {
    const card = demoCard();
    const reversed = Object.fromEntries(Object.entries(card).reverse()) as RuleCard;
    expect(signCard(reversed, newKey).sig).toBe(signCard(card, newKey).sig);
  });

  it('survives a JSON round trip', () => {
    const signed = JSON.parse(JSON.stringify(signCard(demoCard(), newKey)));
    expect(verifyCard(signed, keys, NOW)).toEqual(demoCard());
  });

  const card = demoCard({ allowedCategories: ['running_shoes'] });
  it.each(Object.keys(card) as (keyof RuleCard)[])('mutating %s -> bad_signature', (key) => {
    const signed = signCard(card, newKey);
    const tampered = { ...signed, card: mutate(card, key) };
    expect(reason(() => verifyCard(tampered, keys, NOW))).toBe('bad_signature');
  });

  it('rejects an added field', () => {
    const signed = signCard(demoCard(), newKey);
    const tampered = { ...signed, card: { ...signed.card, allowedCategories: ['gift_cards'] } };
    expect(reason(() => verifyCard(tampered, keys, NOW))).toBe('bad_signature');
  });

  it('rejects a signature from the wrong key under a known key ID', () => {
    const forged = { ...signCard(demoCard(), oldKey), keyId: newKey.id };
    expect(reason(() => verifyCard(forged, keys, NOW))).toBe('bad_signature');
  });

  it('rejects a truncated signature', () => {
    const signed = signCard(demoCard(), newKey);
    expect(reason(() => verifyCard({ ...signed, sig: signed.sig.slice(0, 10) }, keys, NOW))).toBe(
      'bad_signature',
    );
  });

  it('supports key rotation', () => {
    const fromOld = signCard(demoCard(), oldKey);
    const fromNew = signCard(demoCard(), newKey);
    expect(verifyCard(fromOld, keys, NOW)).toEqual(demoCard());
    expect(verifyCard(fromNew, keys, NOW)).toEqual(demoCard());
    expect(reason(() => verifyCard(fromOld, { k2: newKey.secret }, NOW))).toBe('unknown_key');
  });

  it('rejects an unknown key ID, including inherited names', () => {
    const signed = signCard(demoCard(), newKey);
    expect(reason(() => verifyCard({ ...signed, keyId: 'k9' }, keys, NOW))).toBe('unknown_key');
    expect(reason(() => verifyCard({ ...signed, keyId: 'toString' }, keys, NOW))).toBe(
      'unknown_key',
    );
  });

  it('rejects a validly signed card that fails the schema', () => {
    const bad = { ...demoCard(), holdTimeoutMinutes: 4320 };
    const signed = signCard(bad, newKey);
    expect(reason(() => verifyCard(signed, keys, NOW))).toBe('schema');
  });

  it('rejects a malformed envelope', () => {
    expect(reason(() => verifyCard(null, keys, NOW))).toBe('schema');
    const signed = signCard(demoCard(), newKey);
    expect(reason(() => verifyCard({ ...signed, alg: 'none' }, keys, NOW))).toBe('schema');
  });

  it('rejects an expired card', () => {
    const signed = signCard(demoCard(), newKey);
    const at = new Date(demoCard().expiresAt);
    expect(reason(() => verifyCard(signed, keys, at))).toBe('expired');
    expect(verifyCard(signed, keys, new Date(at.getTime() - 1))).toEqual(demoCard());
  });

  it('fingerprint is the first 8 characters of the signature', () => {
    const signed = signCard(demoCard(), newKey);
    expect(fingerprint(signed)).toBe(signed.sig.slice(0, 8));
    expect(fingerprint(signed)).toHaveLength(8);
  });
});
